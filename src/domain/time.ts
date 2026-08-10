/**
 * Wall-clock arithmetic in a named timezone. Pure: no clock of its own, no database, no
 * timers. Everything here is "what does a clock on the wall in that zone read", and its
 * inverse, "which instant reads like that".
 *
 * Two callers need the same answers and must not disagree. The scheduler steps a cron
 * expression forward in local time (spec 06, criterion 4), and the planner turns a working
 * window such as 09:00 to 17:30 into the pair of instants a day's capacity is measured
 * between (spec 05). Both are the same question, so both ask it here.
 */

/** A wall-clock reading: what a clock on the wall in that timezone says. */
export interface WallClock {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

export interface WallClockWithSeconds extends WallClock {
  second: number
}

/** A calendar date with no time in it, which is what a daily plan is keyed by. */
export interface LocalDate {
  readonly year: number
  readonly month: number
  readonly day: number
}

/** True when the timezone is one this runtime knows. Used by the configuration schema. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone })
    return true
  } catch {
    return false
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const existing = formatters.get(timeZone)
  if (existing !== undefined) return existing

  // Built once per timezone and kept: constructing one of these is expensive relative to
  // formatting with it, and stepping a cron expression formats a great many instants.
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })

  formatters.set(timeZone, formatter)
  return formatter
}

/**
 * What the wall clock in `timeZone` reads at that instant. `Intl` is the only thing in the
 * runtime that knows the world's DST rules, so it is what the offsets are derived from rather
 * than a table this repository would have to keep up to date.
 */
export function wallClockAt(epoch: number, timeZone: string): WallClockWithSeconds {
  const parts = formatterFor(timeZone).formatToParts(new Date(epoch))
  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? 0)

  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  }
}

function asUtc(clock: WallClock, second = 0): number {
  return Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute, second)
}

/** The timezone's offset from UTC at that instant, in milliseconds. */
function offsetAt(epoch: number, timeZone: string): number {
  const clock = wallClockAt(epoch, timeZone)
  // The seconds are carried through so that a zone with a sub-minute historical offset does
  // not contribute a rounding error of its own.
  return asUtc(clock, clock.second) - Math.floor(epoch / 1000) * 1000
}

const DAY_MS = 24 * 60 * 60_000

function reads(epoch: number, clock: WallClock, timeZone: string): boolean {
  const reading = wallClockAt(epoch, timeZone)
  return (
    reading.year === clock.year &&
    reading.month === clock.month &&
    reading.day === clock.day &&
    reading.hour === clock.hour &&
    reading.minute === clock.minute
  )
}

/**
 * The first instant at which that wall clock reads in that timezone, or null when it never
 * does.
 *
 * Both cases are real. The hour a spring-forward skips has no instant: 01:30 simply does not
 * happen that day, and a schedule naming it does not fire rather than firing at some nearby
 * time nobody asked for. The hour an autumn change repeats has two, and the answer is the
 * first of them.
 *
 * Deriving one from the other by arithmetic cannot answer either question, because the offset
 * to subtract is the one in force at an instant that is not known yet. So each offset in force
 * anywhere near the wanted reading is tried, each candidate is read back, and the earliest
 * that reads back correctly is the answer. A day either side covers every transition there is.
 */
export function epochForWallClock(clock: WallClock, timeZone: string): number | null {
  const naive = asUtc(clock)
  const offsets = new Set([
    offsetAt(naive - DAY_MS, timeZone),
    offsetAt(naive, timeZone),
    offsetAt(naive + DAY_MS, timeZone),
  ])

  const candidates = [...offsets]
    .map((offset) => naive - offset)
    .filter((epoch) => reads(epoch, clock, timeZone))
    .sort((first, second) => first - second)

  return candidates[0] ?? null
}

/** Sunday is 0. The weekday of a calendar date is the same in every timezone. */
export function dayOfWeekOf(date: LocalDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** The calendar date that instant falls on, in that timezone. */
export function localDateAt(epoch: number, timeZone: string): LocalDate {
  const clock = wallClockAt(epoch, timeZone)
  return { year: clock.year, month: clock.month, day: clock.day }
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0')
}

/** `YYYY-MM-DD`, which is how a plan's date reaches the database and the URL. */
export function formatLocalDate(date: LocalDate): string {
  return `${pad(date.year, 4)}-${pad(date.month)}-${pad(date.day)}`
}

/**
 * A `YYYY-MM-DD` back into a date, or null when it is not one. Real dates only: `2026-02-30`
 * parses as three numbers and is refused, because a plan for a day that does not exist would
 * be stored under a key nothing could ever ask for again.
 */
export function parseLocalDate(text: string): LocalDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (match === null) return null

  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  if (month < 1 || month > 12) return null
  if (day < 1 || day > daysInMonth(year, month)) return null

  return { year, month, day }
}

/**
 * A whole number of calendar days before or after a date. Calendar arithmetic rather than
 * elapsed milliseconds: fourteen days before the 6th of April is the 23rd of March, and
 * subtracting fourteen times twenty-four hours from a local midnight lands on the 22nd in any
 * zone that put its clocks forward in between.
 */
export function addDays(date: LocalDate, days: number): LocalDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days))

  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  }
}

/**
 * The instant a wall-clock time on that date corresponds to, resolved forwards through a
 * spring-forward gap. A working day that starts at 01:00 in a zone where 01:00 does not exist
 * that morning still has to start somewhere, and the first minute that does exist is the
 * honest answer; a schedule, by contrast, simply does not fire, which is why `nextCronTime`
 * uses `epochForWallClock` directly rather than this.
 */
export function instantAt(
  date: LocalDate,
  minutesFromMidnight: number,
  timeZone: string,
): number | null {
  // Bounded by the end of the day the caller named: a reading past midnight belongs to the
  // next date, and answering with it would silently move the window off the day it describes.
  for (let total = minutesFromMidnight; total < 24 * 60; total += 1) {
    const epoch = epochForWallClock(
      { ...date, hour: Math.floor(total / 60), minute: total % 60 },
      timeZone,
    )
    if (epoch !== null) return epoch
  }

  return null
}

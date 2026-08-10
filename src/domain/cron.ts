/**
 * Cron expressions, parsed and stepped forward in a named timezone. Pure: no clock, no
 * timers, no database. The scheduler asks it "when next, after this moment", which is the
 * only question a schedule has to answer. Spec 06.
 *
 * Five fields, the standard ones: minute, hour, day of month, month, day of week. No seconds
 * field, because the finest cadence any of these jobs wants is a minute, and no non-standard
 * extensions, because a schedule nobody can read is a schedule nobody can check.
 *
 * The wall-clock arithmetic lives in `time.ts`, because the planner's working window asks the
 * same question of the same timezone and the two must not answer it differently.
 */
import {
  dayOfWeekOf,
  daysInMonth,
  epochForWallClock,
  isValidTimeZone,
  wallClockAt,
  type WallClock,
} from './time.js'

export { isValidTimeZone }

/** A cron expression that cannot be parsed, or that names a moment that never arrives. */
export class CronError extends Error {
  override readonly name = 'CronError'
}

export interface CronFields {
  readonly minutes: ReadonlySet<number>
  readonly hours: ReadonlySet<number>
  readonly daysOfMonth: ReadonlySet<number>
  readonly months: ReadonlySet<number>
  /** Sunday is 0. A 7 in the expression is normalised to 0 on the way in. */
  readonly daysOfWeek: ReadonlySet<number>
  /**
   * Whether each day field was narrowed from `*`. Cron's oldest quirk: when both day fields
   * are restricted, a date matching *either* fires, rather than one matching both. `30 7 1 * 1`
   * is "the first of the month and every Monday", not "Mondays that fall on the first".
   */
  readonly restrictedDayOfMonth: boolean
  readonly restrictedDayOfWeek: boolean
}

interface FieldRange {
  readonly name: string
  readonly min: number
  readonly max: number
}

const fieldRanges: readonly FieldRange[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of week', min: 0, max: 7 },
]

/**
 * One field. A star, a star with a step, a value, a range, a range with a step, and
 * comma-separated lists of those: every form these schedules need and nothing that would need
 * explaining twice.
 */
function parseField(raw: string, range: FieldRange): Set<number> {
  const values = new Set<number>()

  for (const part of raw.split(',')) {
    // A part carries at most one step. Reading the first two pieces and discarding the rest would
    // accept `*/2/3` as a plain step of two, so the job would run on a schedule nobody wrote.
    const [spec, stepText, ...extra] = part.split('/')
    if (
      spec === undefined ||
      spec === '' ||
      extra.length > 0 ||
      (stepText !== undefined && stepText === '')
    ) {
      throw new CronError(`The ${range.name} field of a cron expression is malformed: "${raw}"`)
    }

    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(step) || step < 1) {
      throw new CronError(`The ${range.name} step in "${raw}" must be a whole number above zero`)
    }

    const [from, to] = bounds(spec, range, raw, stepText !== undefined)
    for (let value = from; value <= to; value += step) values.add(value)
  }

  return values
}

/** The inclusive bounds one comma-separated part covers, before its step is applied. */
function bounds(spec: string, range: FieldRange, raw: string, hasStep: boolean): [number, number] {
  if (spec === '*') return [range.min, range.max]

  const [fromText, toText, ...rest] = spec.split('-')
  if (rest.length > 0) {
    throw new CronError(`The ${range.name} range in "${raw}" has more than one dash`)
  }

  const from = number(fromText, range, raw)
  // A single value covers itself and no more. The one exception is a single value carrying a
  // step, which reads as "from here to the top of the field, every n": that is what makes
  // `0/15` and the star form of it the same schedule.
  const to = toText === undefined ? (hasStep ? range.max : from) : number(toText, range, raw)

  if (to < from) {
    throw new CronError(`The ${range.name} range in "${raw}" ends before it starts`)
  }

  return [from, to]
}

function number(text: string | undefined, range: FieldRange, raw: string): number {
  const value = Number(text)
  if (text === undefined || text === '' || !Number.isInteger(value)) {
    throw new CronError(`The ${range.name} field in "${raw}" is not a whole number: "${text}"`)
  }
  if (value < range.min || value > range.max) {
    throw new CronError(
      `The ${range.name} field in "${raw}" must be between ${range.min} and ${range.max}, got ${value}`,
    )
  }
  return value
}

export function parseCron(expression: string): CronFields {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) {
    throw new CronError(
      `A cron expression has five fields (minute hour day-of-month month day-of-week), got ${fields.length}: "${expression}"`,
    )
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [
    string,
    string,
    string,
    string,
    string,
  ]

  const daysOfWeek = new Set(
    // Sunday is both 0 and 7 in every cron there has ever been, and the two mean the same day.
    [...parseField(dayOfWeek, fieldRanges[4] as FieldRange)].map((day) => (day === 7 ? 0 : day)),
  )

  return {
    minutes: parseField(minute, fieldRanges[0] as FieldRange),
    hours: parseField(hour, fieldRanges[1] as FieldRange),
    daysOfMonth: parseField(dayOfMonth, fieldRanges[2] as FieldRange),
    months: parseField(month, fieldRanges[3] as FieldRange),
    daysOfWeek,
    restrictedDayOfMonth: dayOfMonth !== '*',
    restrictedDayOfWeek: dayOfWeek !== '*',
  }
}

/**
 * True when the expression parses **and** names a moment that arrives. Used by the configuration
 * schema, where both halves matter: `0 0 30 2 *` parses cleanly and never fires, and the scheduler
 * would otherwise meet it as a `CronError` thrown out of `start()` and out of every read of
 * `/api/jobs/status`. A configuration problem belongs at configuration load.
 *
 * Reachability is checked in UTC. Which zone it is read in cannot make an unreachable date
 * reachable, and a daily minute that one zone skips on one day still arrives on the next.
 */
export function isValidCron(expression: string, from = Date.now()): boolean {
  try {
    nextCronTime(parseCron(expression), from, 'UTC')
    return true
  } catch {
    return false
  }
}

/** Cron's either-or rule for the two day fields. See `CronFields`. */
function dayMatches(fields: CronFields, clock: WallClock): boolean {
  const byDate = fields.daysOfMonth.has(clock.day)
  const byWeekday = fields.daysOfWeek.has(dayOfWeekOf(clock))

  if (fields.restrictedDayOfMonth && fields.restrictedDayOfWeek) return byDate || byWeekday
  if (fields.restrictedDayOfMonth) return byDate
  if (fields.restrictedDayOfWeek) return byWeekday
  return true
}

function nextDay(clock: WallClock): WallClock {
  const day = clock.day + 1
  if (day <= daysInMonth(clock.year, clock.month)) {
    return { ...clock, day, hour: 0, minute: 0 }
  }
  return clock.month === 12
    ? { year: clock.year + 1, month: 1, day: 1, hour: 0, minute: 0 }
    : { ...clock, month: clock.month + 1, day: 1, hour: 0, minute: 0 }
}

/**
 * How far ahead a search will look before giving up. Four years covers every reachable
 * schedule including the 29th of February; a schedule that is not reachable in four years,
 * such as the 30th of February, is a mistake worth being told about rather than a search that
 * runs for as long as the process lives.
 */
const SEARCH_DAYS = 366 * 4

/**
 * The first instant after `after` at which the expression fires, read in `timeZone`. The
 * search walks the wall clock rather than the epoch, which is what makes a daily 07:30 stay
 * at 07:30 across a DST change: the clock field is what the schedule names, and the instant it
 * corresponds to is derived afterwards. Spec 06, criterion 4.
 */
export function nextCronTime(fields: CronFields, after: number, timeZone: string): number {
  // Whole minutes only, and strictly after: a schedule that has just fired must not answer
  // with the same minute again.
  const start = wallClockAt(after + 60_000 - (after % 60_000), timeZone)
  let clock: WallClock = {
    year: start.year,
    month: start.month,
    day: start.day,
    hour: start.hour,
    minute: start.minute,
  }

  const limit = clock.year + 5
  let days = 0

  while (days <= SEARCH_DAYS && clock.year <= limit) {
    if (!fields.months.has(clock.month) || !dayMatches(fields, clock)) {
      clock = nextDay(clock)
      days += 1
      continue
    }

    if (!fields.hours.has(clock.hour)) {
      clock = clock.hour === 23 ? nextDay(clock) : { ...clock, hour: clock.hour + 1, minute: 0 }
      if (clock.hour === 0 && clock.minute === 0) days += 1
      continue
    }

    if (fields.minutes.has(clock.minute)) {
      const epoch = epochForWallClock(clock, timeZone)
      // A wall-clock minute the zone skips, or one that resolves to an instant already past
      // because the clocks went back and this minute has happened once already.
      if (epoch !== null && epoch > after) return epoch
    }

    if (clock.minute === 59) {
      clock = clock.hour === 23 ? nextDay(clock) : { ...clock, hour: clock.hour + 1, minute: 0 }
      if (clock.hour === 0 && clock.minute === 0) days += 1
    } else {
      clock = { ...clock, minute: clock.minute + 1 }
    }
  }

  throw new CronError(
    `No moment in the next ${SEARCH_DAYS} days satisfies this schedule, so it would never fire`,
  )
}

/**
 * How often the schedule comes round, measured as the gap between the next two firings after
 * `after`. The scheduler uses it to decide whether a job is overdue after downtime, which
 * needs a cadence rather than a calendar. Spec 06, startup.
 */
export function cronInterval(fields: CronFields, after: number, timeZone: string): number {
  const first = nextCronTime(fields, after, timeZone)
  return nextCronTime(fields, first, timeZone) - first
}

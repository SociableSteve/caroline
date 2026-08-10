/**
 * Free capacity for a day, from the calendar. Spec 05:
 *
 *     capacity = workingWindow - busyTime - reserve
 *
 * Pure: no database, no clock, no calendar client. Everything it needs is an argument, which
 * is what lets every rule in spec 05's Capacity section be asserted without a fixture.
 */
import type { CalendarEventFacts } from './calendar.js'
import { instantAt, type LocalDate, dayOfWeekOf } from './time.js'

const MINUTE_MS = 60_000

/** A half-open span of time. `end` is not part of it, so two that touch do not overlap. */
export interface Interval {
  readonly start: number
  readonly end: number
}

export interface CapacityOptions {
  /**
   * Whether an all-day event takes the day. Spec 02 defaults it off: a public holiday and a
   * week-long conference are both all-day events, and only one of them means you are busy.
   */
  readonly countAllDayEvents: boolean
}

/**
 * Whether this event takes time off the day. Spec 05: the union of intervals that are
 * "accepted or unanswered, not marked free". An invitation nobody has answered is still a
 * claim on the hour, so it counts; declining it is what releases the time.
 */
export function consumesCapacity(
  event: CalendarEventFacts,
  { countAllDayEvents }: CapacityOptions,
): boolean {
  if (event.status === 'cancelled') return false
  if (event.transparency === 'transparent') return false
  if (event.responseStatus === 'declined') return false
  if (event.allDay && !countAllDayEvents) return false

  return true
}

/**
 * The intervals as one non-overlapping, ordered set. Overlapping meetings count once, which
 * is spec 05 criterion 2, and two that merely touch are joined because no minute between them
 * is free. Zero-length intervals are dropped: a meeting of no duration takes no time.
 */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const ordered = intervals
    .filter((interval) => interval.end > interval.start)
    .toSorted((first, second) => first.start - second.start)

  const merged: Interval[] = []

  for (const interval of ordered) {
    const last = merged[merged.length - 1]

    if (last === undefined || interval.start > last.end) {
      merged.push(interval)
      continue
    }

    if (interval.end > last.end)
      merged[merged.length - 1] = { start: last.start, end: interval.end }
  }

  return merged
}

/** The part of `interval` inside `window`, or null when none of it is. Criterion 4. */
export function clipTo(interval: Interval, window: Interval): Interval | null {
  const start = Math.max(interval.start, window.start)
  const end = Math.min(interval.end, window.end)

  return end > start ? { start, end } : null
}

/** What is left of the window once the busy blocks are taken out. The dashboard shows these. */
export function freeIntervals(window: Interval, busy: readonly Interval[]): Interval[] {
  const free: Interval[] = []
  let cursor = window.start

  for (const block of mergeIntervals(busy)) {
    const clipped = clipTo(block, window)
    if (clipped === null) continue

    if (clipped.start > cursor) free.push({ start: cursor, end: clipped.start })
    cursor = Math.max(cursor, clipped.end)
  }

  if (cursor < window.end) free.push({ start: cursor, end: window.end })

  return free
}

/** The working day, as configured: local clock times and which weekdays count. Spec 05. */
export interface WorkingHours {
  /** Minutes from local midnight. 09:00 is 540. */
  readonly startMinute: number
  readonly endMinute: number
  /** Sunday is 0, matching cron and `Date`. Default is Monday to Friday. */
  readonly days: readonly number[]
}

/**
 * The pair of instants the working day spans, or null on a day that is not a working day.
 *
 * Resolved through `instantAt`, so the window keeps its wall-clock reading across a DST
 * change: a nine-to-five day is eight hours in the summer and eight hours in the winter, and
 * the seven and a half hours the spring-forward Sunday would produce is the correct answer for
 * a day the clocks changed rather than an error.
 */
export function workingWindowFor(
  date: LocalDate,
  timeZone: string,
  hours: WorkingHours,
): Interval | null {
  if (!hours.days.includes(dayOfWeekOf(date))) return null

  const start = instantAt(date, hours.startMinute, timeZone)
  const end = instantAt(date, hours.endMinute, timeZone)
  if (start === null || end === null || end <= start) return null

  return { start, end }
}

export interface CapacityInput extends CapacityOptions {
  readonly window: Interval
  readonly events: readonly CalendarEventFacts[]
  /** Held back for interruptions, as a percentage of the window. Spec 05 defaults it to 20. */
  readonly reservePercent: number
}

export interface Capacity {
  readonly window: Interval
  readonly windowMinutes: number
  readonly busyMinutes: number
  readonly reserveMinutes: number
  /**
   * What is left to plan into. Deliberately not clamped: a day with more meetings in it than
   * hours is a real day, and spec 05 asks the plan to say so rather than to report an empty
   * diary as a full one.
   */
  readonly capacityMinutes: number
  /** The busy blocks, merged and clipped to the window, for the dashboard's calendar column. */
  readonly busy: readonly Interval[]
  readonly free: readonly Interval[]
}

function minutesOf(intervals: readonly Interval[]): number {
  return Math.round(
    intervals.reduce((total, interval) => total + (interval.end - interval.start), 0) / MINUTE_MS,
  )
}

export function computeCapacity({
  window,
  events,
  reservePercent,
  countAllDayEvents,
}: CapacityInput): Capacity {
  const busy = mergeIntervals(
    events
      .filter((event) => consumesCapacity(event, { countAllDayEvents }))
      .map((event) => clipTo({ start: event.startsAt, end: event.endsAt }, window))
      .filter((interval): interval is Interval => interval !== null),
  )

  const windowMinutes = minutesOf([window])
  const busyMinutes = minutesOf(busy)
  const reserveMinutes = Math.round((windowMinutes * reservePercent) / 100)

  return {
    window,
    windowMinutes,
    busyMinutes,
    reserveMinutes,
    capacityMinutes: windowMinutes - busyMinutes - reserveMinutes,
    busy,
    free: freeIntervals(window, busy),
  }
}

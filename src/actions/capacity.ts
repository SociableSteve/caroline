/**
 * A day's working window and the capacity left in it, in one place. Three callers ask the
 * question now: `GET /api/calendar`, the planner, and chat's `get_capacity` tool. Spec 08
 * criterion 6 is that the capacity bar's numbers match the calendar route, and spec 07 has chat
 * answering "what does today look like"; all three being true at once is a property of there
 * being one computation rather than three that agree today.
 */
import type { Config } from '../config/schema.js'
import type { Database } from '../db/connection.js'
import { listCalendarEvents } from '../db/repositories/calendar-events.js'
import type { CalendarEvent } from '../domain/calendar.js'
import { computeCapacity, workingWindowFor, type Interval } from '../domain/capacity.js'
import { instantAt, localDateAt, type LocalDate } from '../domain/time.js'

const DAY_MS = 24 * 60 * 60_000

/** How many minutes into the day a local `HH:MM` is. The config carries the readable form. */
function minutesOfDay(time: string): number {
  const [hour = '0', minute = '0'] = time.split(':')
  return Number(hour) * 60 + Number(minute)
}

/** The configured working window on a date, or null when the date is not a working day. */
export function workingWindowForDate(config: Config, date: LocalDate): Interval | null {
  return workingWindowFor(date, config.jobs.timezone, {
    startMinute: minutesOfDay(config.planning.workingWindow.start),
    endMinute: minutesOfDay(config.planning.workingWindow.end),
    days: config.planning.workingDays,
  })
}

/** The whole local day, which is the range the calendar column draws. */
export function dayBounds(date: LocalDate, timeZone: string): Interval {
  const start = instantAt(date, 0, timeZone)
  // A day is bounded by the next day's midnight rather than by 23:59, so an event running to
  // the end of the evening is inside it.
  const nextDay = localDateAt((start ?? 0) + 36 * 60 * 60_000, timeZone)
  const end = instantAt(nextDay, 0, timeZone)

  return { start: start ?? 0, end: end ?? (start ?? 0) + DAY_MS }
}

/** The capacity of a day, as the API returns it and the bar draws it. */
export interface DayCapacity {
  readonly windowMinutes: number
  readonly busyMinutes: number
  readonly reserveMinutes: number
  /** May be negative: a day with more meetings in it than working hours says so. Spec 05. */
  readonly capacityMinutes: number
  /** False when no calendar is connected, so the window was assumed free. */
  readonly verified: boolean
  readonly workingDay: boolean
  readonly windowStart: number | null
  readonly windowEnd: number | null
  readonly busy: readonly Interval[]
  readonly free: readonly Interval[]
}

/**
 * A day that is not a working day has no window, and so no capacity. Reported as zeroes with
 * `workingDay: false` rather than as an absent object, so the bar has numbers to draw and the
 * screen has a reason to show for them.
 */
export function capacityFrom(
  window: Interval | null,
  events: readonly CalendarEvent[],
  config: Config,
  connected: boolean,
): DayCapacity {
  if (window === null) {
    return {
      windowMinutes: 0,
      busyMinutes: 0,
      reserveMinutes: 0,
      capacityMinutes: 0,
      verified: connected,
      workingDay: false,
      windowStart: null,
      windowEnd: null,
      busy: [],
      free: [],
    }
  }

  const capacity = computeCapacity({
    window,
    events,
    reservePercent: config.planning.reservePercent,
    countAllDayEvents: config.planning.countAllDayEvents,
  })

  return {
    windowMinutes: capacity.windowMinutes,
    busyMinutes: capacity.busyMinutes,
    reserveMinutes: capacity.reserveMinutes,
    capacityMinutes: capacity.capacityMinutes,
    verified: connected,
    workingDay: true,
    windowStart: window.start,
    windowEnd: window.end,
    busy: capacity.busy,
    free: capacity.free,
  }
}

/**
 * The capacity of a date, read from whatever is stored. With nothing ever connected there is
 * nothing to read and the window is taken as free; disconnecting clears the diary, so there is
 * no third case and nothing to filter out here.
 */
export function capacityForDate(
  database: Database,
  config: Config,
  date: LocalDate,
  connected: boolean,
): DayCapacity {
  const window = workingWindowForDate(config, date)
  const events =
    window === null ? [] : listCalendarEvents(database, { from: window.start, to: window.end })

  return capacityFrom(window, events, config, connected)
}

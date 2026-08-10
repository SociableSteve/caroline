/**
 * The calendar pass. Spec 02: a rolling window from the primary calendar plus any configured
 * ones, stored in `calendar_events`, never becoming tasks.
 *
 * It does not go through the sync engine's `applyItem`, because it has no sources and no tasks
 * to apply anything to: an event is a fact about a day, not a piece of work. It does go through
 * `runConnectorPass`, because it is a connector run in every other respect and belongs in the
 * history as `sync:gcal` alongside the others.
 */
import { runConnectorPass, type ConnectorRunResult, type Tally } from '../engine.js'
import type { Database } from '../../db/connection.js'
import {
  purgeUnseenCalendarEvents,
  upsertCalendarEvent,
} from '../../db/repositories/calendar-events.js'
import type { JobTrigger } from '../../domain/job.js'
import { instantAt, localDateAt } from '../../domain/time.js'
import type { CalendarApi, CalendarRange } from './api.js'
import { toCalendarEventInput } from './map.js'

/** The calendar Google gives everyone, under the name it answers to. */
export const PRIMARY_CALENDAR = 'primary'

const DAY_MS = 24 * 60 * 60_000

export interface CalendarWindowDays {
  readonly lookbackDays: number
  readonly lookaheadDays: number
}

/**
 * The rolling window to read, aligned to local midnights rather than to the moment the job
 * happens to run. A window from "now minus a day" would slide by fifteen minutes on every sync
 * and leave the first minutes of the earliest day flickering in and out of the sweep.
 */
export function calendarWindowFor(
  now: number,
  timeZone: string,
  { lookbackDays, lookaheadDays }: CalendarWindowDays,
): CalendarRange {
  const midnight = (offsetDays: number): number => {
    const date = localDateAt(now + offsetDays * DAY_MS, timeZone)
    // Only a zone that skips its own midnight can fail here, and only for that one day. The
    // approximate instant is a better answer than no calendar at all.
    return instantAt(date, 0, timeZone) ?? now + offsetDays * DAY_MS
  }

  return { from: midnight(-lookbackDays), to: midnight(lookaheadDays + 1) }
}

export interface CalendarSyncOptions {
  readonly database: Database
  readonly api: CalendarApi
  /** False with no credentials or no consent, which has the pass skip rather than fail. */
  readonly isConfigured: () => boolean
  /** Calendars besides the primary one. Spec 02. */
  readonly calendarIds: readonly string[]
  /** The zone an all-day event's date is read in. Spec 02. */
  readonly timeZone: string
  readonly range: CalendarRange
  readonly trigger: JobTrigger
  readonly now: () => number
}

export function runCalendarSync(options: CalendarSyncOptions): Promise<ConnectorRunResult> {
  const { database, isConfigured, trigger, now } = options

  return runConnectorPass(
    { database, provider: 'gcal', trigger, isConfigured, now },
    (tally, startedAt) => readEveryCalendar(options, tally, startedAt),
  )
}

/**
 * Each calendar in turn. A failure on one is held and re-thrown once the others have been
 * read, so a stale shared calendar in the configuration does not cost the primary calendar's
 * events: the run still fails, and says which calendar failed, but the day's capacity is
 * computed from what was actually readable.
 */
async function readEveryCalendar(
  options: CalendarSyncOptions,
  tally: Tally,
  startedAt: number,
): Promise<void> {
  const pass = options.api.beginPass()
  const calendars = [PRIMARY_CALENDAR, ...options.calendarIds]
  const failures: unknown[] = []

  for (const calendarId of calendars) {
    try {
      await readCalendar(options, calendarId, pass, tally, startedAt)
    } catch (error) {
      failures.push(error)
    }
  }

  const first = failures[0]
  if (first !== undefined) throw first
}

/**
 * `startedAt` is the moment the whole run began, shared by every calendar in it. What the sweep
 * below asks is "what did this pass not touch", and a per-calendar clock reading would make
 * that a different question for each calendar in the same run.
 */
async function readCalendar(
  { database, api, range, timeZone }: CalendarSyncOptions,
  calendarId: string,
  pass: AbortSignal,
  tally: Tally,
  startedAt: number,
): Promise<void> {
  const events = await api.listEvents(calendarId, range, pass)

  for (const event of events) {
    tally.itemsSeen += 1

    // An event Caroline cannot make sense of costs that event and nothing else. The pass has
    // no business failing over one malformed row when the rest of the diary is readable.
    const input = toCalendarEventInput(event, calendarId, timeZone)
    if (input === null) continue

    upsertCalendarEvent(database, input, startedAt)
    tally.eventsStored += 1
  }

  // Only after a calendar has been read in full. An event deleted upstream simply stops being
  // returned, so there is no deletion to apply and the absence is the signal; sweeping after a
  // failed read would take the whole fortnight out on the strength of a timeout.
  tally.eventsRemoved += purgeUnseenCalendarEvents(database, {
    calendarId,
    from: range.from,
    to: range.to,
    syncedBefore: startedAt,
  })
}

/**
 * The calendar store. Events are kept only to say how much of a day is already spoken for
 * (spec 05) and to render the dashboard's calendar column (spec 08).
 */
import { randomUUID } from 'node:crypto'
import type { Database } from '../connection.js'
import { booleanToInteger, type Row } from '../rows.js'
import type {
  CalendarEvent,
  CalendarEventStatus,
  CalendarResponseStatus,
  CalendarTransparency,
} from '../../domain/calendar.js'

export interface CalendarEventInput {
  readonly calendarId: string
  readonly externalId: string
  readonly summary: string | null
  readonly startsAt: number
  readonly endsAt: number
  readonly allDay: boolean
  readonly responseStatus: CalendarResponseStatus
  readonly transparency: CalendarTransparency
  readonly status: CalendarEventStatus
  readonly attendeeCount: number
  readonly url: string | null
}

const columns = `id, calendar_id, external_id, summary, starts_at, ends_at, all_day,
  response_status, transparency, status, attendee_count, url, synced_at`

function toCalendarEvent(row: Row): CalendarEvent {
  return {
    id: String(row.id),
    calendarId: String(row.calendar_id),
    externalId: String(row.external_id),
    summary: row.summary === null || row.summary === undefined ? null : String(row.summary),
    startsAt: Number(row.starts_at),
    endsAt: Number(row.ends_at),
    allDay: Number(row.all_day) !== 0,
    responseStatus: String(row.response_status) as CalendarResponseStatus,
    transparency: String(row.transparency) as CalendarTransparency,
    status: String(row.status) as CalendarEventStatus,
    attendeeCount: Number(row.attendee_count),
    url: row.url === null || row.url === undefined ? null : String(row.url),
    syncedAt: Number(row.synced_at),
  }
}

export interface UpsertedCalendarEvent {
  readonly event: CalendarEvent
  /**
   * Whether anything a reader would notice changed: a new event, or one whose time, summary,
   * response or status moved. `synced_at` is excluded, because every pass restamps every event
   * it saw and a diary nobody has touched must not read as a diary that changed.
   */
  readonly changed: boolean
}

/** The fields that make one event different from another, `synced_at` deliberately absent. */
function isSameEvent(existing: CalendarEvent, input: CalendarEventInput): boolean {
  return (
    existing.summary === input.summary &&
    existing.startsAt === input.startsAt &&
    existing.endsAt === input.endsAt &&
    existing.allDay === input.allDay &&
    existing.responseStatus === input.responseStatus &&
    existing.transparency === input.transparency &&
    existing.status === input.status &&
    existing.attendeeCount === input.attendeeCount &&
    existing.url === input.url
  )
}

/**
 * Writes the event, or updates the one already there. A meeting that moved is the same
 * meeting, so the key is the calendar and the provider's own id rather than anything about
 * when it happens. `synced_at` is stamped on every pass, which is what later lets a pass
 * sweep up whatever it did not see.
 *
 * Reports whether the event actually changed. The sync tally counts only those, because the
 * change feed publishes on a non-zero count: counting every event a pass saw would have every
 * open tab reload every quarter of an hour for a diary that had not moved.
 */
export function upsertCalendarEvent(
  database: Database,
  input: CalendarEventInput,
  now: number,
): UpsertedCalendarEvent {
  const before = database
    .prepare(`select ${columns} from calendar_events where calendar_id = ? and external_id = ?`)
    .get(input.calendarId, input.externalId)

  const existing = before === undefined ? null : toCalendarEvent(before as Row)

  database
    .prepare(
      `insert into calendar_events (${columns}) values (
         :id, :calendar_id, :external_id, :summary, :starts_at, :ends_at, :all_day,
         :response_status, :transparency, :status, :attendee_count, :url, :synced_at
       )
       on conflict (calendar_id, external_id) do update set
         summary = excluded.summary,
         starts_at = excluded.starts_at,
         ends_at = excluded.ends_at,
         all_day = excluded.all_day,
         response_status = excluded.response_status,
         transparency = excluded.transparency,
         status = excluded.status,
         attendee_count = excluded.attendee_count,
         url = excluded.url,
         synced_at = excluded.synced_at`,
    )
    .run({
      id: randomUUID(),
      calendar_id: input.calendarId,
      external_id: input.externalId,
      summary: input.summary,
      starts_at: input.startsAt,
      ends_at: input.endsAt,
      all_day: booleanToInteger(input.allDay),
      response_status: input.responseStatus,
      transparency: input.transparency,
      status: input.status,
      attendee_count: input.attendeeCount,
      url: input.url,
      synced_at: now,
    })

  const row = database
    .prepare(`select ${columns} from calendar_events where calendar_id = ? and external_id = ?`)
    .get(input.calendarId, input.externalId)

  return {
    event: toCalendarEvent(row as Row),
    changed: existing === null || !isSameEvent(existing, input),
  }
}

export interface CalendarRange {
  readonly from: number
  readonly to: number
}

/**
 * Every event that overlaps the range, earliest first. Overlap rather than containment: a
 * meeting that started before the working window opened and runs into it takes time off the
 * day, and one that ends exactly as the range opens does not.
 */
export function listCalendarEvents(
  database: Database,
  { from, to }: CalendarRange,
): CalendarEvent[] {
  return database
    .prepare(
      `select ${columns} from calendar_events
       where starts_at < ? and ends_at > ?
       order by starts_at, ends_at, id`,
    )
    .all(to, from)
    .map((row) => toCalendarEvent(row as Row))
}

export function countCalendarEvents(database: Database): number {
  return Number(
    (database.prepare('select count(*) as count from calendar_events').get() as Row).count,
  )
}

export interface PurgeUnseenInput extends CalendarRange {
  readonly calendarId: string
  /** Anything this calendar last saw before this moment was not in the pass that just ran. */
  readonly syncedBefore: number
}

/**
 * Drops the events in the window that the pass just finished did not see. An event deleted or
 * declined out of existence upstream simply stops being returned, so there is no deletion to
 * apply; sweeping is what keeps a meeting cancelled last week off today's dashboard.
 *
 * Bounded to the window the pass actually looked at, and to the calendar it looked at, so a
 * pass over one calendar's fortnight cannot delete another's, or next year's.
 */
export function purgeUnseenCalendarEvents(
  database: Database,
  { calendarId, from, to, syncedBefore }: PurgeUnseenInput,
): number {
  return Number(
    database
      .prepare(
        `delete from calendar_events
         where calendar_id = ? and synced_at < ? and starts_at < ? and ends_at > ?`,
      )
      .run(calendarId, syncedBefore, to, from).changes,
  )
}

/** Removes one outright, for an event upstream reports as cancelled. */
export function deleteCalendarEvent(
  database: Database,
  calendarId: string,
  externalId: string,
): boolean {
  return (
    Number(
      database
        .prepare('delete from calendar_events where calendar_id = ? and external_id = ?')
        .run(calendarId, externalId).changes,
    ) > 0
  )
}

/** Everything, for the deletion path: disconnecting the account leaves no diary behind. */
export function deleteAllCalendarEvents(database: Database): number {
  return Number(database.prepare('delete from calendar_events').run().changes)
}

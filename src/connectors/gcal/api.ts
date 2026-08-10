/**
 * The Calendar side of the connector: the one call it makes, the shape of what comes back, and
 * the HTTP client that makes it. Nothing here knows about capacity, plans or the database,
 * which is what lets the connector be driven by recorded fixtures with no network anywhere in
 * the suite. Spec 02, criterion 8.
 *
 * Read-only. No writing to a calendar, ever: spec 02 and spec 05 both name time-blocking as a
 * non-goal, and there is no code path here that could.
 */
import { createGoogleClient } from '../google/http.js'
import type { GoogleCalendarEvent } from './map.js'

export const CALENDAR_BASE_URL = 'https://www.googleapis.com/calendar/v3'

/** A calendar call that failed. Its message is what ends up in the run history. */
export class CalendarApiError extends Error {
  override readonly name = 'CalendarApiError'
}

/** How many events one request asks for. Google's own maximum is 2500. */
export const LIST_PAGE = 250

/**
 * A runaway guard rather than a policy: the listing is paged until Google says there is no
 * more. Ten pages of 250 events is a fortnight nobody could attend, and failing loudly beats
 * returning a partial result set, because an afternoon missing from it reads as an afternoon
 * that is free and the plan would be drawn against time already spoken for.
 */
export const LIST_MAX_PAGES = 10

export interface CalendarRange {
  readonly from: number
  readonly to: number
}

export interface CalendarApi {
  /** One budget for the whole pass, shared by every request it makes. See `google/http.ts`. */
  beginPass(): AbortSignal
  listEvents(
    calendarId: string,
    range: CalendarRange,
    pass?: AbortSignal,
  ): Promise<GoogleCalendarEvent[]>
}

export interface CalendarApiOptions {
  readonly accessToken: () => Promise<string>
  readonly baseUrl?: string
  readonly fetch?: typeof globalThis.fetch
  readonly timeoutMs?: number
  readonly passTimeoutMs?: number
}

interface ListResponse {
  readonly items?: readonly GoogleCalendarEvent[]
  readonly nextPageToken?: unknown
}

export function createCalendarApi({
  accessToken,
  baseUrl = CALENDAR_BASE_URL,
  fetch,
  timeoutMs,
  passTimeoutMs,
}: CalendarApiOptions): CalendarApi {
  const client = createGoogleClient({
    product: 'Google Calendar',
    baseUrl,
    accessToken,
    fail: (message) => new CalendarApiError(message),
    ...(fetch === undefined ? {} : { fetch }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(passTimeoutMs === undefined ? {} : { passTimeoutMs }),
  })

  const { beginPass: budget, get } = client

  return {
    beginPass: budget,

    async listEvents(calendarId, range, pass = budget()) {
      const events: GoogleCalendarEvent[] = []
      let pageToken: string | null = null

      // Bounded rather than open: the guard below is what ends the loop, and the trailing
      // return exists only because TypeScript cannot see that.
      for (let page = 0; page < LIST_MAX_PAGES; page += 1) {
        const search = new URLSearchParams({
          // Occurrences rather than recurrence rules. A weekly meeting is a rule, and a rule
          // cannot be subtracted from a Tuesday: only its occurrence on that Tuesday can.
          singleEvents: 'true',
          orderBy: 'startTime',
          showDeleted: 'false',
          maxResults: String(LIST_PAGE),
          timeMin: new Date(range.from).toISOString(),
          timeMax: new Date(range.to).toISOString(),
        })
        if (pageToken !== null) search.set('pageToken', pageToken)

        const path = `/calendars/${encodeURIComponent(calendarId)}/events?${search.toString()}`

        let body: ListResponse
        try {
          body = (await get(path, pass)) as ListResponse
        } catch (error) {
          throw named(error, calendarId)
        }

        events.push(...(body.items ?? []))

        const next = body.nextPageToken
        if (typeof next !== 'string' || next === '') return events

        pageToken = next

        // Still more pages after the guard. Returning what has been read so far would read as
        // the whole fortnight, and every meeting missing from it would look like free time.
        if (page === LIST_MAX_PAGES - 1) {
          throw new CalendarApiError(
            `The calendar "${calendarId}" still had pages after ${LIST_MAX_PAGES} of ${LIST_PAGE}. Narrow integrations.google.calendarLookaheadDays.`,
          )
        }
      }

      return events
    },
  }
}

/**
 * Which calendar the failure was about. A configuration naming three calendars produces three
 * requests, and "Google Calendar answered 404 Not Found" does not say which of them to take
 * out of the file.
 */
function named(error: unknown, calendarId: string): unknown {
  if (!(error instanceof CalendarApiError)) return error

  return new CalendarApiError(`${error.message} (calendar "${calendarId}")`)
}

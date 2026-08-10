/**
 * The Calendar HTTP client, over a stubbed `fetch`. Nothing here reaches Google.
 *
 * What it has to get right is the query: single events rather than recurrence rules, because
 * capacity is computed from occurrences and not from patterns, and a window that is bounded at
 * both ends so a decade of history is not fetched every quarter of an hour.
 */
import { describe, expect, it } from 'vitest'
import { CalendarApiError, createCalendarApi } from '../../../src/connectors/gcal/api.js'

interface StubbedReply {
  readonly status?: number
  readonly body?: unknown
}

function api(replies: readonly StubbedReply[]) {
  const urls: string[] = []
  const headers: Array<Record<string, string>> = []
  let served = 0

  const fetch: typeof globalThis.fetch = async (input, init) => {
    urls.push(String(input))
    const seen: Record<string, string> = {}
    new Headers(init?.headers).forEach((value, key) => {
      seen[key] = value
    })
    headers.push(seen)

    const reply = replies[Math.min(served, replies.length - 1)] ?? {}
    served += 1

    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  return {
    urls,
    headers,
    calendar: createCalendarApi({
      accessToken: () => Promise.resolve('access-1'),
      fetch,
    }),
  }
}

const RANGE = { from: Date.UTC(2026, 5, 8), to: Date.UTC(2026, 5, 22) }

describe('listing events', () => {
  it('sends the bearer token and returns what came back', async () => {
    const { calendar, headers } = api([{ body: { items: [{ id: 'event-1' }] } }])

    const events = await calendar.listEvents('primary', RANGE)

    expect(events.map((event) => event.id)).toEqual(['event-1'])
    expect(headers[0]?.authorization).toBe('Bearer access-1')
  })

  /**
   * Recurrence expanded into occurrences. A weekly meeting is a rule, and a rule cannot be
   * subtracted from a Tuesday: only the occurrence on that Tuesday can.
   */
  it('asks for single events within the window, ordered by start', async () => {
    const { calendar, urls } = api([{ body: { items: [] } }])

    await calendar.listEvents('primary', RANGE)

    const url = new URL(urls[0] ?? '')
    expect(url.searchParams.get('singleEvents')).toBe('true')
    expect(url.searchParams.get('orderBy')).toBe('startTime')
    expect(url.searchParams.get('timeMin')).toBe('2026-06-08T00:00:00.000Z')
    expect(url.searchParams.get('timeMax')).toBe('2026-06-22T00:00:00.000Z')
  })

  it('escapes a calendar id, which is an address rather than a path segment', async () => {
    const { calendar, urls } = api([{ body: { items: [] } }])

    await calendar.listEvents('team+room@example.com', RANGE)

    expect(urls[0]).toContain('/calendars/team%2Broom%40example.com/events')
  })

  it('follows the pages Google offers', async () => {
    const { calendar, urls } = api([
      { body: { items: [{ id: 'event-1' }], nextPageToken: 'page-2' } },
      { body: { items: [{ id: 'event-2' }] } },
    ])

    const events = await calendar.listEvents('primary', RANGE)

    expect(events.map((event) => event.id)).toEqual(['event-1', 'event-2'])
    expect(urls[1]).toContain('pageToken=page-2')
  })

  /**
   * A truncated result set reads as an empty afternoon, which is worse than a failed run: the
   * plan would be drawn against time that is already booked.
   */
  it('fails rather than truncating when the pages do not run out', async () => {
    const { calendar } = api([{ body: { items: [{ id: 'event-1' }], nextPageToken: 'more' } }])

    await expect(calendar.listEvents('primary', RANGE)).rejects.toThrow(/still had pages/)
  })
})

describe('a refused request', () => {
  it('reads a quota refusal as one to wait out', async () => {
    const { calendar } = api([
      {
        status: 403,
        body: {
          error: { message: 'Rate limit exceeded.', errors: [{ reason: 'rateLimitExceeded' }] },
        },
      },
    ])

    await expect(calendar.listEvents('primary', RANGE)).rejects.toThrow(
      /Google Calendar rate limit reached/i,
    )
  })

  it('reads a permission refusal as one to reconnect for', async () => {
    const { calendar } = api([
      {
        status: 403,
        body: {
          error: {
            message: 'Request had insufficient authentication scopes.',
            errors: [{ reason: 'insufficientPermissions' }],
          },
        },
      },
    ])

    const failure = await calendar.listEvents('primary', RANGE).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(CalendarApiError)
    expect((failure as Error).message).toMatch(/reconnect the Google account/i)
    expect((failure as Error).message).not.toMatch(/rate limit/i)
  })

  /**
   * A calendar id that no longer exists is the one refusal worth naming: the fix is to take it
   * out of the configuration, and nothing else says so.
   */
  it('names the calendar when Google says there is no such one', async () => {
    const { calendar } = api([{ status: 404, body: { error: { message: 'Not Found' } } }])

    await expect(calendar.listEvents('team@example.com', RANGE)).rejects.toThrow(
      /team@example\.com/,
    )
  })

  it('says to reconnect when the token itself is rejected', async () => {
    const { calendar } = api([{ status: 401, body: {} }])

    await expect(calendar.listEvents('primary', RANGE)).rejects.toThrow(
      /Reconnect the Google account/,
    )
  })
})

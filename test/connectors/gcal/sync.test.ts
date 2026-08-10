/**
 * The calendar pass: read a rolling window from every configured calendar, store what is
 * there, and sweep up what has gone. Driven by the recorded payload, with no network.
 *
 * The rule that matters most is spec 02 criterion 7, and it is asserted here as well as in the
 * schema: however many events a pass reads, it creates no tasks and no sources.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { CalendarApi, CalendarRange } from '../../../src/connectors/gcal/api.js'
import { CalendarApiError } from '../../../src/connectors/gcal/api.js'
import type { GoogleCalendarEvent } from '../../../src/connectors/gcal/map.js'
import { calendarWindowFor, runCalendarSync } from '../../../src/connectors/gcal/sync.js'
import { listCalendarEvents } from '../../../src/db/repositories/calendar-events.js'
import { listJobRuns } from '../../../src/db/repositories/job-runs.js'
import { listTasks } from '../../../src/db/repositories/tasks.js'
import type { Database } from '../../../src/db/connection.js'
import { migratedDatabase } from '../../helpers/temp-database.js'

const LONDON = 'Europe/London'
const NOW = Date.UTC(2026, 5, 8, 6, 0, 0)
const DAY = 24 * 60 * 60_000

function recordedEvents(): GoogleCalendarEvent[] {
  const path = fileURLToPath(new URL('../../fixtures/gcal/primary-week.json', import.meta.url))
  return (JSON.parse(readFileSync(path, 'utf8')) as { items: GoogleCalendarEvent[] }).items
}

interface FakeCalendarApi extends CalendarApi {
  readonly calendarsRead: string[]
  readonly ranges: CalendarRange[]
}

function fakeCalendarApi(
  perCalendar: Record<string, readonly GoogleCalendarEvent[]>,
  failWith?: Error,
): FakeCalendarApi {
  const calendarsRead: string[] = []
  const ranges: CalendarRange[] = []

  return {
    calendarsRead,
    ranges,
    beginPass: () => AbortSignal.timeout(60_000),
    async listEvents(calendarId, range) {
      if (failWith !== undefined) throw failWith

      calendarsRead.push(calendarId)
      ranges.push(range)
      return [...(perCalendar[calendarId] ?? [])]
    },
  }
}

interface SyncOptions {
  readonly database?: Database
  readonly api?: CalendarApi
  readonly isConfigured?: boolean
  readonly calendarIds?: readonly string[]
  readonly now?: number
}

function sync({
  database = migratedDatabase(),
  api = fakeCalendarApi({ primary: recordedEvents() }),
  isConfigured = true,
  calendarIds = [],
  now = NOW,
}: SyncOptions = {}) {
  return {
    database,
    result: runCalendarSync({
      database,
      api,
      isConfigured: () => isConfigured,
      calendarIds,
      timeZone: LONDON,
      range: calendarWindowFor(now, LONDON, { lookbackDays: 1, lookaheadDays: 14 }),
      trigger: 'scheduled',
      now: () => now,
    }),
  }
}

describe('the window a pass reads', () => {
  it('opens at the start of the local day, a configured number of days back', () => {
    const range = calendarWindowFor(NOW, LONDON, { lookbackDays: 1, lookaheadDays: 14 })

    expect(new Date(range.from).toISOString()).toBe('2026-06-06T23:00:00.000Z')
  })

  it('closes at the end of the local day, a configured number of days forward', () => {
    const range = calendarWindowFor(NOW, LONDON, { lookbackDays: 1, lookaheadDays: 14 })

    expect(new Date(range.to).toISOString()).toBe('2026-06-22T23:00:00.000Z')
  })

  it('still spans today when nothing is looked back or forward', () => {
    const range = calendarWindowFor(NOW, LONDON, { lookbackDays: 0, lookaheadDays: 1 })

    expect(range.from).toBeLessThan(NOW)
    expect(range.to).toBeGreaterThan(NOW)
  })
})

describe('a pass over the recorded fortnight', () => {
  it('stores every event it could map', async () => {
    const { database, result } = sync()
    await result

    const stored = listCalendarEvents(database, { from: NOW - DAY, to: NOW + 20 * DAY })

    expect(stored.map((event) => event.externalId).toSorted()).toEqual([
      'event-bank-holiday',
      'event-cancelled',
      'event-focus',
      'event-invite-unanswered',
      'event-standup',
      'event-vendor-call',
    ])
  })

  it('counts what it saw and what it stored', async () => {
    const { result } = sync()

    expect(await result).toMatchObject({
      provider: 'gcal',
      status: 'success',
      counts: expect.objectContaining({ itemsSeen: 6, eventsStored: 6 }),
    })
  })

  /** Spec 02, criterion 7, through the whole pass rather than at the schema. */
  it('creates no tasks and no sources, whatever is in the diary', async () => {
    const { database, result } = sync()
    await result

    expect(listTasks(database, {}, NOW).total).toBe(0)
    expect(database.prepare('select count(*) as count from sources').get()).toMatchObject({
      count: 0,
    })
  })

  it('records its own run under the connector’s name', async () => {
    const { database, result } = sync()
    await result

    expect(listJobRuns(database, { job: 'sync:gcal' })[0]).toMatchObject({
      status: 'success',
      trigger: 'scheduled',
    })
  })

  it('reads the primary calendar and every configured one', async () => {
    const api = fakeCalendarApi({ primary: [], 'team@example.com': [] })
    await sync({ api, calendarIds: ['team@example.com'] }).result

    expect(api.calendarsRead).toEqual(['primary', 'team@example.com'])
  })

  it('running twice over the same payload leaves one row per event', async () => {
    const database = migratedDatabase()
    await sync({ database }).result
    await sync({ database, now: NOW + 60_000 }).result

    expect(listCalendarEvents(database, { from: NOW - DAY, to: NOW + 20 * DAY })).toHaveLength(6)
  })
})

/**
 * An event deleted or moved out of the window upstream simply stops being returned, so a pass
 * sweeps up whatever it did not see rather than leaving last week's cancelled meeting on the
 * dashboard for ever.
 */
describe('what a pass sweeps up', () => {
  it('removes an event the calendar no longer returns', async () => {
    const database = migratedDatabase()
    await sync({ database }).result

    const remaining = recordedEvents().filter((event) => event.id !== 'event-standup')
    const { result } = sync({
      database,
      api: fakeCalendarApi({ primary: remaining }),
      now: NOW + 60_000,
    })

    expect(await result).toMatchObject({
      counts: expect.objectContaining({ eventsRemoved: 1 }),
    })
    expect(
      listCalendarEvents(database, { from: NOW - DAY, to: NOW + 20 * DAY }).map(
        (e) => e.externalId,
      ),
    ).not.toContain('event-standup')
  })

  it('sweeps nothing when the calendar returned everything it did before', async () => {
    const database = migratedDatabase()
    await sync({ database }).result

    const { result } = sync({ database, now: NOW + 60_000 })

    expect((await result).counts.eventsRemoved).toBe(0)
  })
})

describe('when it cannot run', () => {
  it('is skipped rather than failed with no account connected', async () => {
    const { result } = sync({ isConfigured: false })

    expect(await result).toMatchObject({ status: 'skipped', error: null })
  })

  it('records the skip, so the history says why nothing happened', async () => {
    const { database, result } = sync({ isConfigured: false })
    await result

    expect(listJobRuns(database, { job: 'sync:gcal' })[0]).toMatchObject({ status: 'skipped' })
  })

  it('fails with the message Google gave rather than throwing out of the pass', async () => {
    const { result } = sync({
      api: fakeCalendarApi({}, new CalendarApiError('Google Calendar rate limit reached (429).')),
    })

    expect(await result).toMatchObject({
      status: 'failure',
      error: expect.stringMatching(/rate limit reached/),
    })
  })

  /** A failed pass must not sweep: it saw nothing, which is not the same as nothing being there. */
  it('leaves what it already had alone when the pass fails', async () => {
    const database = migratedDatabase()
    await sync({ database }).result

    await sync({
      database,
      api: fakeCalendarApi({}, new CalendarApiError('Google Calendar is down')),
      now: NOW + 60_000,
    }).result

    expect(listCalendarEvents(database, { from: NOW - DAY, to: NOW + 20 * DAY })).toHaveLength(6)
  })

  /**
   * One unreachable calendar should not take the others with it: the primary calendar is
   * usually the one capacity turns on, and a stale shared calendar is a configuration problem.
   */
  it('keeps the events from the calendars it could read', async () => {
    const database = migratedDatabase()
    const api: CalendarApi = {
      beginPass: () => AbortSignal.timeout(60_000),
      async listEvents(calendarId) {
        if (calendarId !== 'primary') throw new CalendarApiError('no such calendar')
        return recordedEvents()
      },
    }

    const { result } = sync({ database, api, calendarIds: ['team@example.com'] })

    expect(await result).toMatchObject({
      status: 'failure',
      error: expect.stringMatching(/no such calendar/),
    })
    expect(listCalendarEvents(database, { from: NOW - DAY, to: NOW + 20 * DAY })).toHaveLength(6)
  })
})

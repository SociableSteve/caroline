/**
 * `GET /api/plan/:date`, its regenerate counterpart and `GET /api/calendar`. Spec 08's route
 * table, and criterion 6: the capacity bar's numbers match `GET /api/calendar` for the same
 * date, which is true here because both read the same computation.
 */
import { describe, expect, it } from 'vitest'
import { upsertCalendarEvent } from '../../src/db/repositories/calendar-events.js'
import { recordDailyPlan } from '../../src/db/repositories/daily-plans.js'
import { createTask } from '../../src/db/repositories/tasks.js'
import type { Database } from '../../src/db/connection.js'
import { migratedDatabase } from '../helpers/temp-database.js'
import { REQUEST_TIME, testServer } from '../helpers/test-server.js'

/** `REQUEST_TIME` is 2026-06-01T09:00:00Z, a Monday, which is a working day in the defaults. */
const TODAY = '2026-06-01'
const HOUR = 60 * 60_000
/** 09:00 local (BST) on that Monday. */
const NINE = Date.UTC(2026, 5, 1, 8, 0, 0)

function aPlanOn(database: Database, planDate: string, summary = 'A steady day.') {
  const task = createTask(
    database,
    { title: 'Book the venue', status: 'next_action' },
    REQUEST_TIME,
  )

  return recordDailyPlan(database, {
    planDate,
    generatedAt: REQUEST_TIME,
    timeZone: 'Europe/London',
    windowMinutes: 510,
    busyMinutes: 60,
    reserveMinutes: 102,
    capacityMinutes: 348,
    capacityVerified: true,
    provider: 'ollama',
    model: 'a-model',
    promptVersion: '2026-08-10',
    summary,
    warnings: ['one thing to know'],
    entries: [
      { taskId: task.id, title: task.title, rank: 1, rationale: 'It is next', estimateMinutes: 30 },
    ],
    overflow: [],
    nudges: [
      {
        taskId: null,
        title: 'Signed contract',
        rank: 1,
        waitingOn: 'Legal',
        waitingSince: REQUEST_TIME - 30 * 24 * HOUR,
        pushedSinceReview: false,
      },
    ],
  })
}

function aMeeting(database: Database, startsAt: number, endsAt: number, externalId = 'event-1') {
  upsertCalendarEvent(
    database,
    {
      calendarId: 'primary',
      externalId,
      summary: 'Hub weekly',
      startsAt,
      endsAt,
      allDay: false,
      responseStatus: 'accepted',
      transparency: 'opaque',
      status: 'confirmed',
      attendeeCount: 3,
      url: null,
    },
    REQUEST_TIME,
  )
}

describe('GET /api/plan/:date', () => {
  it('answers with the plan for that date', async () => {
    const database = migratedDatabase()
    aPlanOn(database, TODAY)
    const { app } = await testServer({ database })

    const response = await app.inject({ method: 'GET', url: `/api/plan/${TODAY}` })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      date: TODAY,
      plan: {
        planDate: TODAY,
        capacityMinutes: 348,
        capacityVerified: true,
        summary: 'A steady day.',
        warnings: ['one thing to know'],
      },
    })
  })

  it('carries the entries, the overflow and the nudges apart from each other', async () => {
    const database = migratedDatabase()
    aPlanOn(database, TODAY)
    const { app } = await testServer({ database })

    const { plan } = (await app.inject({ method: 'GET', url: `/api/plan/${TODAY}` })).json()

    expect(plan.entries).toHaveLength(1)
    expect(plan.entries[0]).toMatchObject({ rank: 1, rationale: 'It is next', done: false })
    expect(plan.overflow).toEqual([])
    expect(plan.nudges[0]).toMatchObject({ waitingOn: 'Legal', title: 'Signed contract' })
  })

  it('defaults to today when no date is given', async () => {
    const database = migratedDatabase()
    aPlanOn(database, TODAY)
    const { app } = await testServer({ database })

    const response = await app.inject({ method: 'GET', url: '/api/plan' })

    expect(response.json()).toMatchObject({ date: TODAY, plan: { planDate: TODAY } })
  })

  /** Spec 08 criterion 4: no plan is an empty state, not an error. */
  it('answers with no plan rather than a 404 for a day nothing was planned for', async () => {
    const { app } = await testServer()

    const response = await app.inject({ method: 'GET', url: '/api/plan/2026-06-02' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ date: '2026-06-02', plan: null })
  })

  it('carries the fortnight of planned against completed the dashboard shows', async () => {
    const database = migratedDatabase()
    aPlanOn(database, TODAY)
    const { app } = await testServer({ database })

    const { history } = (await app.inject({ method: 'GET', url: `/api/plan/${TODAY}` })).json()

    expect(history).toEqual([{ planDate: TODAY, planned: 1, completed: 0 }])
  })

  /**
   * The fortnight is fourteen calendar days, not fourteen times twenty-four hours. The UK
   * clocks went forward on 29 March 2026, so elapsed-hours arithmetic would open the window on
   * the 22nd and quietly make it fifteen days once a year.
   */
  it('counts the fortnight back in calendar days across a spring-forward', async () => {
    const database = migratedDatabase()
    aPlanOn(database, '2026-03-23', 'the earliest day still in the fortnight')
    aPlanOn(database, '2026-03-22', 'the day before it, which is out')
    const { app } = await testServer({ database })

    const { history } = (await app.inject({ method: 'GET', url: '/api/plan/2026-04-06' })).json()

    expect(history.map((day: { planDate: string }) => day.planDate)).toEqual(['2026-03-23'])
  })

  it.each(['not-a-date', '2026-6-1', '2026-02-30', '20260601'])(
    'refuses "%s", which is not a date',
    async (date) => {
      const { app } = await testServer()

      const response = await app.inject({ method: 'GET', url: `/api/plan/${date}` })

      expect(response.statusCode).toBe(400)
      expect(response.json()).toMatchObject({ error: { code: expect.any(String) } })
    },
  )
})

describe('POST /api/plan/:date/regenerate', () => {
  /**
   * The planner is skipped with no provider configured, which is the state a test server is in.
   * What is asserted is the path: the route reaches the job and reports what it said.
   */
  it('runs the planner and answers with whatever plan there now is', async () => {
    const { app } = await testServer()

    const response = await app.inject({ method: 'POST', url: `/api/plan/${TODAY}/regenerate` })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ date: TODAY, plan: null })
  })

  it('records the run, so a regenerate appears in the history like any other', async () => {
    const { app } = await testServer()

    await app.inject({ method: 'POST', url: `/api/plan/${TODAY}/regenerate` })

    const { runs } = (await app.inject({ method: 'GET', url: '/api/jobs?job=plan' })).json()

    expect(runs[0]).toMatchObject({ job: 'plan', trigger: 'manual' })
  })

  /**
   * Yesterday's plan is a record of what was proposed yesterday. Redrawing it against today's
   * tasks would rewrite that record, and the fortnight of planned against completed with it.
   */
  it('refuses a date that is not today', async () => {
    const { app } = await testServer()

    const response = await app.inject({ method: 'POST', url: '/api/plan/2026-05-31/regenerate' })

    expect(response.statusCode).toBe(400)
    expect(response.json().error.message).toMatch(/today/i)
  })

  it('refuses a date that is not a date', async () => {
    const { app } = await testServer()

    const response = await app.inject({ method: 'POST', url: '/api/plan/whenever/regenerate' })

    expect(response.statusCode).toBe(400)
  })
})

describe('GET /api/calendar', () => {
  it('answers with the day’s events', async () => {
    const database = migratedDatabase()
    aMeeting(database, NINE + HOUR, NINE + 2 * HOUR)
    const { app } = await testServer({ database })

    const { events } = (
      await app.inject({ method: 'GET', url: `/api/calendar?date=${TODAY}` })
    ).json()

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      summary: 'Hub weekly',
      startsAt: NINE + HOUR,
      endsAt: NINE + 2 * HOUR,
      allDay: false,
      responseStatus: 'accepted',
    })
  })

  it('leaves out another day’s events', async () => {
    const database = migratedDatabase()
    aMeeting(database, NINE + 24 * HOUR, NINE + 25 * HOUR)
    const { app } = await testServer({ database })

    const { events } = (
      await app.inject({ method: 'GET', url: `/api/calendar?date=${TODAY}` })
    ).json()

    expect(events).toEqual([])
  })

  /** Criterion 6: the same numbers the capacity bar shows. */
  it('computes the capacity for the day', async () => {
    const database = migratedDatabase()
    aMeeting(database, NINE + HOUR, NINE + 2 * HOUR)
    const { app } = await testServer({ database })

    const { capacity } = (
      await app.inject({ method: 'GET', url: `/api/calendar?date=${TODAY}` })
    ).json()

    expect(capacity).toMatchObject({
      windowMinutes: 510,
      busyMinutes: 60,
      reserveMinutes: 102,
      capacityMinutes: 348,
    })
  })

  it('reports the busy and free blocks the calendar column draws', async () => {
    const database = migratedDatabase()
    aMeeting(database, NINE + HOUR, NINE + 2 * HOUR)
    const { app } = await testServer({ database })

    const { capacity } = (
      await app.inject({ method: 'GET', url: `/api/calendar?date=${TODAY}` })
    ).json()

    expect(capacity.busy).toEqual([{ start: NINE + HOUR, end: NINE + 2 * HOUR }])
    expect(capacity.free).toEqual([
      { start: NINE, end: NINE + HOUR },
      { start: NINE + 2 * HOUR, end: NINE + 8.5 * HOUR },
    ])
  })

  it('says the capacity is unverified with no calendar connected', async () => {
    const { app } = await testServer()

    const response = await app.inject({ method: 'GET', url: `/api/calendar?date=${TODAY}` })

    expect(response.json()).toMatchObject({ connected: false, capacity: { verified: false } })
  })

  it('has no window at all on a day that is not a working day', async () => {
    const { app } = await testServer()

    const response = await app.inject({ method: 'GET', url: '/api/calendar?date=2026-06-06' })

    expect(response.json()).toMatchObject({
      capacity: { windowMinutes: 0, capacityMinutes: 0, workingDay: false },
    })
  })

  it('defaults to today', async () => {
    const { app } = await testServer()

    expect((await app.inject({ method: 'GET', url: '/api/calendar' })).json()).toMatchObject({
      date: TODAY,
    })
  })

  it('refuses a date that is not one', async () => {
    const { app } = await testServer()

    expect((await app.inject({ method: 'GET', url: '/api/calendar?date=soon' })).statusCode).toBe(
      400,
    )
  })

  it('refuses a query it does not know, rather than ignoring it', async () => {
    const { app } = await testServer()

    expect((await app.inject({ method: 'GET', url: '/api/calendar?day=today' })).statusCode).toBe(
      400,
    )
  })
})

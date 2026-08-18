/**
 * The planner, against a real database and a fake provider. Spec 05's acceptance criteria are
 * the shape of this file; no test here calls a real model.
 *
 * The rules themselves are asserted in `test/domain/plan.test.ts`, where they are pure. What is
 * asserted here is that the job applies them to real rows, records what it drew, and changes
 * nothing it was not asked to change.
 */
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config/load.js'
import type { Config } from '../../src/config/schema.js'
import type { Database } from '../../src/db/connection.js'
import { upsertCalendarEvent } from '../../src/db/repositories/calendar-events.js'
import { latestDailyPlan, listDailyPlans } from '../../src/db/repositories/daily-plans.js'
import { setUserName } from '../../src/db/repositories/settings.js'
import { upsertSource } from '../../src/db/repositories/sources.js'
import { createTask, getTask, listTasks } from '../../src/db/repositories/tasks.js'
import { runPlanning } from '../../src/jobs/plan.js'
import { createFakeProvider, type FakeAnswer } from '../../src/llm/fake.js'
import type { LlmProvider, LlmRuntime } from '../../src/llm/index.js'
import { withSchemaValidation } from '../../src/llm/structured.js'
import { migratedDatabase } from '../helpers/temp-database.js'

/** A Monday, 07:30 local, which is when the plan job runs. */
const NOW = Date.UTC(2026, 5, 8, 6, 30, 0)
const DAY = 24 * 60 * 60_000
const HOUR = 60 * 60_000
const TODAY = { year: 2026, month: 6, day: 8 }
/** 09:00 to 17:30 in London on that Monday, in UTC. */
const NINE = Date.UTC(2026, 5, 8, 8, 0, 0)

function config(file: Record<string, unknown> = {}): Config {
  return loadConfig({
    file: { jobs: { timezone: 'Europe/London' }, ...file },
    env: {} as NodeJS.ProcessEnv,
  })
}

function runtime(answers: readonly FakeAnswer[], configured = true) {
  const fake = createFakeProvider({ answers, model: 'fake-planner' })
  const validating = withSchemaValidation(fake, { now: () => NOW })

  const llm: LlmRuntime = {
    isConfigured: () => configured,
    for: (): LlmProvider => validating,
  }

  return { llm, fake }
}

/** An answer the plan schema will accept. */
function plan(
  entries: ReadonlyArray<Record<string, unknown>>,
  summary = 'A steady day.',
): FakeAnswer {
  const structured = { summary, entries }
  return { structured, text: JSON.stringify(structured) }
}

interface RunOptions {
  readonly database?: Database
  readonly answers?: readonly FakeAnswer[]
  readonly llmConfigured?: boolean
  readonly calendarConnected?: boolean
  readonly config?: Config
  readonly now?: number
}

async function planFor({
  database = migratedDatabase(),
  answers = [plan([])],
  llmConfigured = true,
  calendarConnected = true,
  config: settings = config(),
  now = NOW,
}: RunOptions = {}) {
  const { llm, fake } = runtime(answers, llmConfigured)

  const result = await runPlanning({
    database,
    config: settings,
    llm,
    calendarConnected: () => calendarConnected,
    now: () => now,
  })

  return { database, result, fake, stored: latestDailyPlan(database, '2026-06-08') }
}

function aNextAction(database: Database, id: string, overrides: Record<string, unknown> = {}) {
  return createTask(
    database,
    { id, title: `Task ${id}`, status: 'next_action', ...overrides },
    NOW - DAY,
  )
}

function aMeeting(database: Database, startsAt: number, endsAt: number) {
  upsertCalendarEvent(
    database,
    {
      calendarId: 'primary',
      externalId: `event-${startsAt}`,
      summary: 'A meeting',
      startsAt,
      endsAt,
      allDay: false,
      responseStatus: 'accepted',
      transparency: 'opaque',
      status: 'confirmed',
      attendeeCount: 2,
      url: null,
    },
    NOW,
  )
}

describe('the capacity a plan is drawn against', () => {
  /** Criterion 1, through the job. */
  it('is the working window less the reserve on an empty day', async () => {
    const { stored } = await planFor()

    expect(stored).toMatchObject({
      windowMinutes: 510,
      busyMinutes: 0,
      reserveMinutes: 102,
      capacityMinutes: 408,
      capacityVerified: true,
    })
  })

  it('takes the day’s meetings out of it', async () => {
    const database = migratedDatabase()
    aMeeting(database, NINE + HOUR, NINE + 2 * HOUR)

    const { stored } = await planFor({ database })

    expect(stored).toMatchObject({ busyMinutes: 60, capacityMinutes: 348 })
  })

  it('ignores an event on another day', async () => {
    const database = migratedDatabase()
    aMeeting(database, NINE + DAY, NINE + DAY + HOUR)

    expect((await planFor({ database })).stored?.busyMinutes).toBe(0)
  })

  /** Criterion 10. */
  it('says capacity is unverified when no calendar is connected', async () => {
    const { stored } = await planFor({ calendarConnected: false })

    expect(stored).toMatchObject({ capacityVerified: false, capacityMinutes: 408 })
  })

  it('still plans the day when no calendar is connected', async () => {
    const database = migratedDatabase()
    aNextAction(database, 'task-a')

    const { stored } = await planFor({
      database,
      calendarConnected: false,
      answers: [plan([{ taskId: 'task-a', rationale: 'It is next', estimateMinutes: 30 }])],
    })

    expect(stored?.entries.map((entry) => entry.taskId)).toEqual(['task-a'])
  })

  it('says so in a warning rather than leaving it to be noticed', async () => {
    const { stored } = await planFor({ calendarConnected: false })

    expect(stored?.warnings.join(' ')).toMatch(/unverified/i)
  })

  /**
   * A connection that has since dropped does not erase what was synced while it was up: the
   * events are still in the database and still get deducted (the two tests above establish that
   * disconnected days plan and their capacity numbers are correct). The warning must not then
   * claim the whole day was assumed free, which is what actually happened.
   */
  it('does not claim the day was assumed free when previously-synced events were deducted', async () => {
    const database = migratedDatabase()
    aMeeting(database, NINE + HOUR, NINE + 2 * HOUR)

    const { stored } = await planFor({ database, calendarConnected: false })

    expect(stored).toMatchObject({ capacityVerified: false, busyMinutes: 60 })
    expect(stored?.warnings.join(' ')).toMatch(/unverified/i)
    expect(stored?.warnings.join(' ')).not.toMatch(/assumes the whole/i)
  })
})

describe('a day that is not a working day', () => {
  const SUNDAY = Date.UTC(2026, 5, 7, 6, 30, 0)

  it('has no capacity and says which day it was', async () => {
    const { database } = await planFor({ now: SUNDAY })
    const stored = latestDailyPlan(database, '2026-06-07')

    expect(stored).toMatchObject({ capacityMinutes: 0, windowMinutes: 0 })
    expect(stored?.warnings.join(' ')).toMatch(/not a working day/i)
  })

  it('does not spend a model call on it', async () => {
    const { fake } = await planFor({ now: SUNDAY })

    expect(fake.requests).toHaveLength(0)
  })
})

describe('what the planner sends and stores', () => {
  it('offers the model today’s candidates and nothing else', async () => {
    const database = migratedDatabase()
    aNextAction(database, 'task-a')
    createTask(database, { id: 'task-someday', title: 'One day', status: 'someday' }, NOW)

    const { fake } = await planFor({ database })
    const sent = String(fake.requests[0]?.messages[0]?.content)

    expect(sent).toContain('task-a')
    expect(sent).not.toContain('task-someday')
  })

  /**
   * Spec 09: the planner writes user-facing prose, and its rationales were in the second person
   * without having been told who they were addressed to. The name is part of what leaves the
   * machine, so it is asserted against the built request.
   */
  it('names the person the plan is for in its system prompt', async () => {
    const database = migratedDatabase()
    aNextAction(database, 'task-a')
    setUserName(database, 'Steve', NOW)

    const { fake } = await planFor({ database })

    expect(fake.requests[0]?.system).toContain('"Steve"')
  })

  it('says it does not know the name when nobody has given one', async () => {
    const database = migratedDatabase()
    aNextAction(database, 'task-a')

    const { fake } = await planFor({ database })

    expect(fake.requests[0]?.system).toMatch(/do not know their name/i)
  })

  /** Spec 09: the planner sends titles and metadata. No message body reaches it. */
  it('sends no message body, whatever is stored against the task', async () => {
    const database = migratedDatabase()
    const task = aNextAction(database, 'task-a')
    upsertSource(
      database,
      {
        provider: 'gmail',
        externalId: 'thread-1',
        taskId: task.id,
        content: 'the secret contents of the message',
        contentLevel: 'full',
      },
      NOW,
    )

    const { fake } = await planFor({ database })

    expect(JSON.stringify(fake.requests)).not.toContain('secret contents')
  })

  it('records the provider, the model and the prompt version it used', async () => {
    const database = migratedDatabase()
    aNextAction(database, 'task-a')

    const { stored } = await planFor({
      database,
      answers: [plan([{ taskId: 'task-a', rationale: 'x', estimateMinutes: 30 }])],
    })

    expect(stored).toMatchObject({ provider: 'ollama', model: 'fake-planner' })
    expect(stored?.promptVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('keeps the model’s summary', async () => {
    const database = migratedDatabase()
    aNextAction(database, 'task-a')

    const { stored } = await planFor({
      database,
      answers: [plan([{ taskId: 'task-a', rationale: 'x', estimateMinutes: 30 }], 'Two reviews.')],
    })

    expect(stored?.summary).toBe('Two reviews.')
  })

  it('counts the plan it generated and the call it made', async () => {
    const database = migratedDatabase()
    aNextAction(database, 'task-a')

    const { result } = await planFor({
      database,
      answers: [plan([{ taskId: 'task-a', rationale: 'x', estimateMinutes: 30 }])],
    })

    expect(result).toMatchObject({
      status: 'success',
      counts: expect.objectContaining({ plansGenerated: 1, llmCalls: 1 }),
    })
  })

  /** A day with nothing eligible still produces a plan, and it cost nothing to produce. */
  it('counts no call on a day it did not need to ask about', async () => {
    const { result } = await planFor()

    expect(result.counts).toMatchObject({ plansGenerated: 1, llmCalls: 0 })
  })
})

/** Criterion 9, and the one most worth a test of its own. */
describe('what generating a plan does not do', () => {
  it('changes no task row', async () => {
    const database = migratedDatabase()
    const before = aNextAction(database, 'task-a', { estimateMinutes: null })

    await planFor({
      database,
      answers: [plan([{ taskId: 'task-a', rationale: 'x', estimateMinutes: 90 }])],
    })

    expect(getTask(database, 'task-a')).toEqual(before)
  })

  it('assigns nothing to the day, so the board is untouched', async () => {
    const database = migratedDatabase()
    aNextAction(database, 'task-a')

    const before = listTasks(database, {}, NOW)
    await planFor({ database })

    expect(listTasks(database, {}, NOW)).toEqual(before)
  })
})

describe('the rules, applied to real rows', () => {
  /** Criterion 5. */
  it('moves what does not fit into overflow', async () => {
    const database = migratedDatabase()
    aNextAction(database, 'task-a', { estimateMinutes: 300 })
    aNextAction(database, 'task-b', { estimateMinutes: 300 })

    const { stored } = await planFor({
      database,
      answers: [
        plan([
          { taskId: 'task-a', rationale: 'first', estimateMinutes: 300 },
          { taskId: 'task-b', rationale: 'second', estimateMinutes: 300 },
        ]),
      ],
    })

    expect(stored?.entries.map((entry) => entry.taskId)).toEqual(['task-a'])
    expect(stored?.overflow.map((entry) => entry.taskId)).toEqual(['task-b'])
  })

  /** Criterion 6. */
  it('puts an overdue task ahead of a discretionary one the model ranked first', async () => {
    const database = migratedDatabase()
    aNextAction(database, 'task-discretionary')
    aNextAction(database, 'task-overdue', { dueAt: NOW - DAY })

    const { stored } = await planFor({
      database,
      answers: [
        plan([
          { taskId: 'task-discretionary', rationale: 'nice to do', estimateMinutes: 30 },
          { taskId: 'task-overdue', rationale: 'late', estimateMinutes: 30 },
        ]),
      ],
    })

    expect(stored?.entries.map((entry) => entry.taskId)).toEqual([
      'task-overdue',
      'task-discretionary',
    ])
  })

  /** Criterion 7. */
  it('plans a review the model left out while the queue is not empty', async () => {
    const database = migratedDatabase()
    aNextAction(database, 'task-a')
    createTask(
      database,
      { id: 'task-pr', title: 'Review the retry helper', status: 'review', statusSetBy: 'sync' },
      NOW - DAY,
    )

    const { stored } = await planFor({
      database,
      answers: [plan([{ taskId: 'task-a', rationale: 'x', estimateMinutes: 30 }])],
    })

    expect(stored?.entries.map((entry) => entry.taskId)).toContain('task-pr')
  })
})

/** Criteria 11 and 12. */
describe('chase nudges', () => {
  function aWaitingTask(database: Database, id: string, since: number, waitingOn = 'Sam') {
    return createTask(database, { id, title: `Waiting ${id}`, status: 'waiting', waitingOn }, since)
  }

  it('surfaces a waiting item past the threshold, naming who and for how long', async () => {
    const database = migratedDatabase()
    aWaitingTask(database, 'task-waiting', NOW - 30 * DAY)

    const { stored } = await planFor({ database })

    expect(stored?.nudges[0]).toMatchObject({
      taskId: 'task-waiting',
      waitingOn: 'Sam',
      waitingSince: NOW - 30 * DAY,
    })
  })

  it('leaves out one still inside the threshold', async () => {
    const database = migratedDatabase()
    aWaitingTask(database, 'task-waiting', NOW - DAY)

    expect((await planFor({ database })).stored?.nudges).toEqual([])
  })

  /** Spec 05: nudges do not consume capacity, because a nudge is a prompt and not a block. */
  it('does not spend capacity on them', async () => {
    const database = migratedDatabase()
    aWaitingTask(database, 'task-waiting', NOW - 30 * DAY)

    const { stored } = await planFor({ database })

    expect(stored?.capacityMinutes).toBe(408)
    expect(stored?.nudges[0]?.estimateMinutes).toBeNull()
  })

  /** Criterion 12: a reviewed pull request the author has not answered is still surfaced. */
  it('says whether the author has pushed since you reviewed', async () => {
    const database = migratedDatabase()
    const task = aWaitingTask(database, 'task-pr', NOW - 30 * DAY, 'author-one')
    upsertSource(
      database,
      {
        provider: 'github',
        externalId: 'example-org/example-service#42',
        taskId: task.id,
        lifecycleState: 'reviewed',
        actedAt: NOW - 30 * DAY,
        actedAtMarker: 'sha-one',
        metadata: { author: 'author-one', headSha: 'sha-two', headCommittedAt: NOW - DAY },
      },
      NOW,
    )

    const { stored } = await planFor({ database })

    expect(stored?.nudges[0]).toMatchObject({ taskId: 'task-pr', pushedSinceReview: true })
  })

  it('dates a pull request’s wait from when you reviewed it, not when it moved', async () => {
    const database = migratedDatabase()
    const task = aWaitingTask(database, 'task-pr', NOW)
    upsertSource(
      database,
      {
        provider: 'github',
        externalId: 'example-org/example-service#42',
        taskId: task.id,
        lifecycleState: 'reviewed',
        actedAt: NOW - 20 * DAY,
        actedAtMarker: 'sha-one',
        metadata: { author: 'author-one', headSha: 'sha-one' },
      },
      NOW,
    )

    expect((await planFor({ database })).stored?.nudges[0]?.waitingSince).toBe(NOW - 20 * DAY)
  })
})

/** Criterion 8. */
describe('regenerating', () => {
  it('creates a new plan and keeps the previous one', async () => {
    const database = migratedDatabase()
    aNextAction(database, 'task-a')
    const entry = [{ taskId: 'task-a', rationale: 'x', estimateMinutes: 30 }]

    await planFor({ database, answers: [plan(entry, 'the first go')] })
    await planFor({ database, answers: [plan(entry, 'the second go')], now: NOW + HOUR })

    const history = listDailyPlans(database, { planDate: '2026-06-08' })

    expect(history.map((entry) => entry.summary)).toEqual(['the second go', 'the first go'])
  })
})

describe('when the planner cannot run', () => {
  it('is skipped, saying so, when no provider is configured', async () => {
    const { result, stored } = await planFor({ llmConfigured: false })

    expect(result).toMatchObject({
      status: 'skipped',
      error: expect.stringMatching(/no llm provider/i),
    })
    expect(stored).toBeNull()
  })

  /** Spec 09: at `none` there is nothing the model could be told, so it is not asked. */
  it('is skipped when the content policy sends nothing', async () => {
    const { result } = await planFor({ config: config({ privacy: { llmContent: 'none' } }) })

    expect(result).toMatchObject({ status: 'skipped' })
  })

  it('fails with the provider’s own message rather than throwing', async () => {
    const database = migratedDatabase()
    aNextAction(database, 'task-a')

    const { result } = await planFor({
      database,
      answers: [{ throws: new Error('the provider is down') }],
    })

    expect(result).toMatchObject({
      status: 'failure',
      error: expect.stringMatching(/the provider is down/),
    })
  })

  it('leaves no half-written plan behind when the call fails', async () => {
    const database = migratedDatabase()
    aNextAction(database, 'task-a')

    await planFor({ database, answers: [{ throws: new Error('the provider is down') }] })

    expect(latestDailyPlan(database, '2026-06-08')).toBeNull()
  })
})

describe('a day with nothing to do', () => {
  /** No candidates is not a failure and not a reason to spend a call. */
  it('records a plan saying so without asking the model', async () => {
    const { fake, stored } = await planFor()

    expect(fake.requests).toHaveLength(0)
    expect(stored?.entries).toEqual([])
    expect(stored?.summary).toMatch(/nothing/i)
  })

  it('still surfaces the chases, since chasing is work', async () => {
    const database = migratedDatabase()
    createTask(
      database,
      { id: 'task-waiting', title: 'Waiting', status: 'waiting', waitingOn: 'Sam' },
      NOW - 30 * DAY,
    )

    const { fake, stored } = await planFor({ database })

    expect(fake.requests).toHaveLength(0)
    expect(stored?.nudges).toHaveLength(1)
  })
})

describe('planning a day other than today', () => {
  it('plans the date it was given', async () => {
    const database = migratedDatabase()
    const { llm } = runtime([plan([])])

    await runPlanning({
      database,
      config: config(),
      llm,
      calendarConnected: () => true,
      now: () => NOW,
      date: { ...TODAY, day: 9 },
    })

    expect(latestDailyPlan(database, '2026-06-09')).not.toBeNull()
    expect(latestDailyPlan(database, '2026-06-08')).toBeNull()
  })
})

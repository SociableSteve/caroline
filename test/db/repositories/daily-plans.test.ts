/**
 * The plan store. Spec 05: regenerating replaces the day's plan and keeps the previous one in
 * history (criterion 8), and the dashboard shows planned against completed for the last
 * fourteen days.
 */
import { describe, expect, it } from 'vitest'
import {
  latestDailyPlan,
  listDailyPlans,
  planHistory,
  recordDailyPlan,
  type RecordDailyPlanInput,
} from '../../../src/db/repositories/daily-plans.js'
import { changeTaskStatus, createTask, setTaskBlocker } from '../../../src/db/repositories/tasks.js'
import type { Database } from '../../../src/db/connection.js'
import { migratedDatabase } from '../../helpers/temp-database.js'

const NOW = Date.UTC(2026, 5, 8, 7, 30, 0)

function aPlan(overrides: Partial<RecordDailyPlanInput> = {}): RecordDailyPlanInput {
  return {
    planDate: '2026-06-08',
    generatedAt: NOW,
    timeZone: 'Europe/London',
    windowMinutes: 510,
    busyMinutes: 60,
    reserveMinutes: 102,
    capacityMinutes: 348,
    capacityVerified: true,
    provider: 'ollama',
    model: 'a-model',
    promptVersion: '2026-08-10',
    summary: 'Two reviews and the hub numbers.',
    warnings: [],
    entries: [],
    overflow: [],
    nudges: [],
    ...overrides,
  }
}

function aTaskIn(database: Database, id: string): string {
  return createTask(database, { id, title: `Task ${id}` }, NOW).id
}

describe('recording a plan', () => {
  it('reads back the capacity it was drawn against', () => {
    const database = migratedDatabase()

    recordDailyPlan(database, aPlan())

    expect(latestDailyPlan(database, '2026-06-08')).toMatchObject({
      planDate: '2026-06-08',
      windowMinutes: 510,
      busyMinutes: 60,
      reserveMinutes: 102,
      capacityMinutes: 348,
      capacityVerified: true,
      model: 'a-model',
      promptVersion: '2026-08-10',
      summary: 'Two reviews and the hub numbers.',
    })
  })

  it('keeps the warnings as a list rather than as one string', () => {
    const database = migratedDatabase()

    recordDailyPlan(database, aPlan({ warnings: ['one thing', 'another'] }))

    expect(latestDailyPlan(database, '2026-06-08')?.warnings).toEqual(['one thing', 'another'])
  })

  it('keeps the three kinds of entry apart and in rank order', () => {
    const database = migratedDatabase()
    const first = aTaskIn(database, 'task-a')
    const second = aTaskIn(database, 'task-b')
    const waiting = aTaskIn(database, 'task-c')

    recordDailyPlan(
      database,
      aPlan({
        entries: [{ taskId: first, title: 'A', rank: 1, rationale: 'first', estimateMinutes: 30 }],
        overflow: [
          {
            taskId: second,
            title: 'B',
            rank: 1,
            rationale: 'if there is time',
            estimateMinutes: 60,
          },
        ],
        nudges: [
          {
            taskId: waiting,
            title: 'C',
            rank: 1,
            waitingOn: 'Sam',
            waitingSince: NOW - 30 * 24 * 60 * 60_000,
            pushedSinceReview: true,
          },
        ],
      }),
    )

    const plan = latestDailyPlan(database, '2026-06-08')

    expect(plan?.entries.map((entry) => entry.title)).toEqual(['A'])
    expect(plan?.overflow.map((entry) => entry.title)).toEqual(['B'])
    expect(plan?.nudges[0]).toMatchObject({ waitingOn: 'Sam', pushedSinceReview: true })
  })

  /**
   * Criterion 4 of spec 08, from the plan's side: the entry has to render as done once the
   * task is, so the current status comes back with it rather than being frozen at plan time.
   */
  it('reports each entry’s task status as it stands now', () => {
    const database = migratedDatabase()
    const taskId = aTaskIn(database, 'task-a')
    recordDailyPlan(
      database,
      aPlan({
        entries: [{ taskId, title: 'A', rank: 1, rationale: 'do it', estimateMinutes: 30 }],
      }),
    )

    changeTaskStatus(database, taskId, { status: 'done', by: 'user', at: NOW + 60_000 })

    expect(latestDailyPlan(database, '2026-06-08')?.entries[0]).toMatchObject({
      taskStatus: 'done',
      done: true,
    })
  })

  /**
   * Spec 05, criterion 20. `waitingOn` is what the planner recorded and `taskStatus` is read now,
   * so a surface presenting an entry under its live status needs what it is waiting on read at the
   * same moment: the blocker's title while it is blocked, the person while it is waiting.
   */
  it('reports what each entry is waiting on as it stands now, beside the status', () => {
    const database = migratedDatabase()
    const taskId = aTaskIn(database, 'task-a')
    const blockerId = aTaskIn(database, 'task-blocker')
    recordDailyPlan(
      database,
      aPlan({
        nudges: [
          {
            taskId,
            title: 'C',
            rank: 1,
            waitingOn: 'Sam',
            waitingSince: NOW,
            pushedSinceReview: false,
          },
        ],
      }),
    )

    setTaskBlocker(database, taskId, blockerId, NOW + 60_000)

    expect(latestDailyPlan(database, '2026-06-08')?.nudges[0]).toMatchObject({
      taskStatus: 'blocked',
      waitingOn: 'Sam',
      currentWaitingOn: 'Task task-blocker',
    })
  })

  it('has nothing current to report for an entry whose task has gone', () => {
    const database = migratedDatabase()
    const taskId = aTaskIn(database, 'task-a')
    recordDailyPlan(
      database,
      aPlan({
        nudges: [
          {
            taskId,
            title: 'C',
            rank: 1,
            waitingOn: 'Sam',
            waitingSince: NOW,
            pushedSinceReview: false,
          },
        ],
      }),
    )

    database.prepare('delete from tasks where id = ?').run(taskId)

    expect(latestDailyPlan(database, '2026-06-08')?.nudges[0]).toMatchObject({
      currentWaitingOn: null,
    })
  })

  /** A plan is a record of what was proposed, so deleting the task does not erase the record. */
  it('keeps an entry whose task has since been deleted, with its title', () => {
    const database = migratedDatabase()
    const taskId = aTaskIn(database, 'task-a')
    recordDailyPlan(
      database,
      aPlan({
        entries: [
          { taskId, title: 'Book the venue', rank: 1, rationale: 'x', estimateMinutes: 30 },
        ],
      }),
    )

    database.prepare('delete from tasks where id = ?').run(taskId)

    expect(latestDailyPlan(database, '2026-06-08')?.entries[0]).toMatchObject({
      taskId: null,
      title: 'Book the venue',
      taskStatus: null,
    })
  })
})

/** Criterion 8. */
describe('regenerating', () => {
  it('answers with the newest plan for the day', () => {
    const database = migratedDatabase()
    recordDailyPlan(database, aPlan({ summary: 'the first go' }))
    recordDailyPlan(database, aPlan({ generatedAt: NOW + 60_000, summary: 'the second go' }))

    expect(latestDailyPlan(database, '2026-06-08')?.summary).toBe('the second go')
  })

  it('keeps the previous one rather than replacing the row', () => {
    const database = migratedDatabase()
    recordDailyPlan(database, aPlan({ summary: 'the first go' }))
    recordDailyPlan(database, aPlan({ generatedAt: NOW + 60_000, summary: 'the second go' }))

    const history = listDailyPlans(database, { planDate: '2026-06-08' })

    expect(history.map((plan) => plan.summary)).toEqual(['the second go', 'the first go'])
  })

  it('has nothing to answer with for a day nothing was planned for', () => {
    expect(latestDailyPlan(migratedDatabase(), '2026-06-09')).toBeNull()
  })
})

describe('the fortnight the dashboard shows', () => {
  it('counts what was planned and how much of it is done, per day', () => {
    const database = migratedDatabase()
    const done = aTaskIn(database, 'task-done')
    const open = aTaskIn(database, 'task-open')

    recordDailyPlan(
      database,
      aPlan({
        entries: [
          { taskId: done, title: 'Done one', rank: 1, rationale: 'x', estimateMinutes: 30 },
          { taskId: open, title: 'Open one', rank: 2, rationale: 'y', estimateMinutes: 30 },
        ],
      }),
    )
    changeTaskStatus(database, done, { status: 'done', by: 'user', at: NOW + 60_000 })

    expect(planHistory(database, { from: '2026-06-01', to: '2026-06-14' })).toEqual([
      { planDate: '2026-06-08', planned: 2, completed: 1 },
    ])
  })

  it('counts only the latest plan for a day that was regenerated', () => {
    const database = migratedDatabase()
    const taskId = aTaskIn(database, 'task-a')
    recordDailyPlan(
      database,
      aPlan({
        entries: [
          { taskId, title: 'A', rank: 1, rationale: 'x', estimateMinutes: 30 },
          {
            taskId: aTaskIn(database, 'task-b'),
            title: 'B',
            rank: 2,
            rationale: 'y',
            estimateMinutes: 30,
          },
        ],
      }),
    )
    recordDailyPlan(
      database,
      aPlan({
        generatedAt: NOW + 60_000,
        entries: [{ taskId, title: 'A', rank: 1, rationale: 'x', estimateMinutes: 30 }],
      }),
    )

    expect(planHistory(database, { from: '2026-06-01', to: '2026-06-14' })).toEqual([
      { planDate: '2026-06-08', planned: 1, completed: 0 },
    ])
  })

  it('leaves overflow and nudges out of the count, since neither was planned work', () => {
    const database = migratedDatabase()
    recordDailyPlan(
      database,
      aPlan({
        overflow: [
          {
            taskId: aTaskIn(database, 'task-a'),
            title: 'A',
            rank: 1,
            rationale: 'x',
            estimateMinutes: 30,
          },
        ],
      }),
    )

    expect(planHistory(database, { from: '2026-06-01', to: '2026-06-14' })).toEqual([
      { planDate: '2026-06-08', planned: 0, completed: 0 },
    ])
  })

  it('says nothing about days with no plan rather than inventing zeroes', () => {
    expect(planHistory(migratedDatabase(), { from: '2026-06-01', to: '2026-06-14' })).toEqual([])
  })
})

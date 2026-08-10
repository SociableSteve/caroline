/**
 * The scheduler's four guarantees, over a real database and real timers. Spec 06.
 *
 * The clock is faked and injected, so nothing here waits for a quarter of an hour, and the timer
 * wiring is the real one rather than a hand-rolled tick.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listJobRuns, recordJobRun } from '../../src/db/repositories/job-runs.js'
import type { Database } from '../../src/db/connection.js'
import { createScheduler, type JobStep, type Schedule } from '../../src/jobs/scheduler.js'
import { createChangeFeed, type ChangeEvent } from '../../src/server/changes.js'
import { migratedDatabase } from '../helpers/temp-database.js'

const START = Date.UTC(2026, 7, 10, 9, 0, 0)
const MINUTE = 60_000

/** A step that records its calls and answers however the test tells it to. */
function step(name: string, answer: () => Promise<Awaited<ReturnType<JobStep['run']>>>) {
  const calls: string[] = []

  return {
    calls,
    step: {
      name,
      run: async (trigger: string) => {
        calls.push(trigger)
        return answer()
      },
    } as unknown as JobStep,
  }
}

function succeeding(name: string) {
  return step(name, () => Promise.resolve({ status: 'success' as const, counts: { itemsSeen: 1 } }))
}

function failing(name: string, message = 'the provider is down') {
  return step(name, () => Promise.resolve({ status: 'failure' as const, error: message }))
}

function build(
  database: Database,
  steps: readonly JobStep[],
  schedules: readonly Schedule[],
  overrides: { backoffBaseMs?: number; backoffCeilingMs?: number; startupStaggerMs?: number } = {},
) {
  const published: ChangeEvent[] = []
  const changes = createChangeFeed()
  changes.subscribe((event) => published.push(event))

  const scheduler = createScheduler({
    database,
    steps,
    schedules,
    timeZone: 'UTC',
    backoffBaseMs: overrides.backoffBaseMs ?? MINUTE,
    backoffCeilingMs: overrides.backoffCeilingMs ?? 60 * MINUTE,
    startupStaggerMs: overrides.startupStaggerMs ?? 0,
    now: () => Date.now(),
    changes,
  })

  return { scheduler, published }
}

/** A success just now, so the cold-start catch-up does not count the job as overdue. */
function recent(database: Database, job: string): void {
  recordJobRun(database, {
    job,
    trigger: 'scheduled',
    startedAt: Date.now(),
    finishedAt: Date.now(),
    status: 'success',
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(START)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('running a job', () => {
  it('records the attempt with its trigger and counts', async () => {
    const database = migratedDatabase()
    const sync = succeeding('sync')
    const { scheduler } = build(database, [sync.step], [])

    const outcome = await scheduler.run('sync', 'manual')

    expect(outcome).toMatchObject({ status: 'ran' })
    expect(listJobRuns(database)).toMatchObject([
      { job: 'sync', trigger: 'manual', status: 'success', counts: { itemsSeen: 1 } },
    ])
  })

  it('answers "unknown" for a job nothing provides, and writes no row for it', async () => {
    const database = migratedDatabase()
    const { scheduler } = build(database, [succeeding('sync').step], [])

    expect(await scheduler.run('plan', 'manual')).toEqual({ status: 'unknown' })
    expect(listJobRuns(database)).toEqual([])
  })

  /** Spec 06, criteria 1, 5 and 6. */
  it('skips a job already in flight, records the skip, and says so', async () => {
    const database = migratedDatabase()
    let release: () => void = () => {}
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })

    const held: JobStep = {
      name: 'sync',
      run: async () => {
        await blocked
        return { status: 'success' }
      },
    }

    const { scheduler } = build(database, [held], [])
    const first = scheduler.run('sync', 'scheduled')
    // The run is in flight the moment `run` is called: the guard is set before anything awaits.
    expect(scheduler.isRunning('sync')).toBe(true)

    const second = await scheduler.run('sync', 'manual')

    expect(second).toEqual({ status: 'already-running' })
    expect(listJobRuns(database)).toMatchObject([
      { job: 'sync', trigger: 'manual', status: 'skipped' },
    ])

    release()
    await first
    expect(scheduler.isRunning('sync')).toBe(false)
    expect(listJobRuns(database, { limit: 5 })).toHaveLength(2)
  })

  /** Spec 06, criterion 7: a job that throws is a failed run, not a dead scheduler. */
  it('records a job that throws as a failure, with its message', async () => {
    const database = migratedDatabase()
    const thrower: JobStep = {
      name: 'classify',
      run: () => {
        throw new Error('nothing is configured')
      },
    }
    const { scheduler } = build(database, [thrower], [])

    await scheduler.run('classify', 'manual')

    expect(listJobRuns(database)).toMatchObject([
      { job: 'classify', status: 'failure', error: 'nothing is configured' },
    ])
  })

  it('announces a run so an open tab reloads without a refresh', async () => {
    const database = migratedDatabase()
    const { scheduler, published } = build(database, [succeeding('sync').step], [])

    await scheduler.run('sync', 'manual')

    // `itemsSeen` alone changed nothing on the board, so only the jobs surface is stale.
    expect(published.map((event) => event.kind)).toEqual(['jobs'])
  })

  it('announces the board as well when the run changed something on it', async () => {
    const database = migratedDatabase()
    const creating = step('sync', () =>
      Promise.resolve({ status: 'success' as const, counts: { tasksCreated: 2 } }),
    )
    const { scheduler, published } = build(database, [creating.step], [])

    await scheduler.run('sync', 'manual')

    expect(published.map((event) => event.kind)).toEqual(['jobs', 'tasks', 'projects'])
  })
})

describe('a chain', () => {
  it('runs its steps in order, each recorded in its own right', async () => {
    const database = migratedDatabase()
    const order: string[] = []
    const steps: JobStep[] = ['sync', 'classify'].map((name) => ({
      name,
      run: async () => {
        order.push(name)
        return { status: 'success' }
      },
    }))

    const { scheduler } = build(database, steps, [
      { job: 'classify', cron: '5 * * * *', chain: ['sync', 'classify'] },
    ])

    // Recent enough that the cold-start catch-up leaves it to the schedule.
    recent(database, 'classify')

    scheduler.start()
    await vi.advanceTimersByTimeAsync(6 * MINUTE)

    expect(order).toEqual(['sync', 'classify'])
    // A row each, under their own names. Both were written in the same faked millisecond, so they
    // are compared as a set rather than in an order the clock cannot distinguish.
    expect(
      listJobRuns(database)
        .filter((run) => run.startedAt > START)
        .map((run) => run.job)
        .sort(),
    ).toEqual(['classify', 'sync'])
  })

  it('carries on after a step fails, because what is ingested is still worth sorting', async () => {
    const database = migratedDatabase()
    const classify = succeeding('classify')
    const { scheduler } = build(
      database,
      [failing('sync').step, classify.step],
      [{ job: 'classify', cron: '5 * * * *', chain: ['sync', 'classify'] }],
    )

    recent(database, 'classify')

    scheduler.start()
    await vi.advanceTimersByTimeAsync(6 * MINUTE)

    expect(classify.calls).toEqual(['scheduled'])
  })
})

describe('the schedule', () => {
  it('fires at the next matching minute and then at the one after', async () => {
    const database = migratedDatabase()
    const sync = succeeding('sync')
    const { scheduler } = build(
      database,
      [sync.step],
      [{ job: 'sync', cron: '*/15 * * * *', chain: ['sync'] }],
    )

    // A success recorded now stops the cold-start catch-up counting it as overdue.
    recordJobRun(database, {
      job: 'sync',
      trigger: 'scheduled',
      startedAt: START,
      finishedAt: START,
      status: 'success',
    })

    scheduler.start()
    expect(sync.calls).toEqual([])

    await vi.advanceTimersByTimeAsync(15 * MINUTE)
    expect(sync.calls).toEqual(['scheduled'])

    await vi.advanceTimersByTimeAsync(15 * MINUTE)
    expect(sync.calls).toEqual(['scheduled', 'scheduled'])
  })

  it('refuses to register a schedule naming a step nothing provides', () => {
    const database = migratedDatabase()

    expect(() =>
      build(
        database,
        [succeeding('sync').step],
        [{ job: 'plan', cron: '0 7 * * *', chain: ['plan'] }],
      ),
    ).toThrow(/no job provides/)
  })

  it('reports when each job next runs, before it has started', () => {
    const database = migratedDatabase()
    const { scheduler } = build(
      database,
      [succeeding('sync').step],
      [{ job: 'sync', cron: '*/15 * * * *', chain: ['sync'] }],
    )

    expect(scheduler.status()).toMatchObject([
      { job: 'sync', cron: '*/15 * * * *', running: false, nextRunAt: START + 15 * MINUTE },
    ])
  })
})

/**
 * Spec 06, criterion 2. The next firing is computed from now rather than from the slots that went
 * by, so a day of downtime is one catch-up run and not ninety-six.
 */
describe('after downtime', () => {
  it('runs each due job exactly once on a cold start', async () => {
    const database = migratedDatabase()
    const sync = succeeding('sync')
    const day = 24 * 60 * MINUTE

    recordJobRun(database, {
      job: 'sync',
      trigger: 'scheduled',
      startedAt: START - day,
      finishedAt: START - day,
      status: 'success',
    })

    const { scheduler } = build(
      database,
      [sync.step],
      [{ job: 'sync', cron: '*/15 * * * *', chain: ['sync'] }],
    )

    scheduler.start()
    await vi.advanceTimersByTimeAsync(1)

    expect(sync.calls).toEqual(['startup'])
  })

  /**
   * On a cold start every job is usually overdue, and their chains overlap: sync is its own
   * schedule and the head of classification's. It runs once, not once per chain that names it.
   */
  it('runs a step named by two overdue chains only once', async () => {
    const database = migratedDatabase()
    const sync = succeeding('sync')
    const classify = succeeding('classify')

    const { scheduler } = build(
      database,
      [sync.step, classify.step],
      [
        { job: 'sync', cron: '*/15 * * * *', chain: ['sync'] },
        { job: 'classify', cron: '5 * * * *', chain: ['sync', 'classify'] },
      ],
      { startupStaggerMs: 1_000 },
    )

    scheduler.start()
    await vi.advanceTimersByTimeAsync(5_000)

    expect(sync.calls).toEqual(['startup'])
    expect(classify.calls).toEqual(['startup'])
  })

  it('does not run a job whose last success is inside its interval', async () => {
    const database = migratedDatabase()
    const sync = succeeding('sync')

    recordJobRun(database, {
      job: 'sync',
      trigger: 'scheduled',
      startedAt: START - MINUTE,
      finishedAt: START - MINUTE,
      status: 'success',
    })

    const { scheduler } = build(
      database,
      [sync.step],
      [{ job: 'sync', cron: '*/15 * * * *', chain: ['sync'] }],
    )

    scheduler.start()
    await vi.advanceTimersByTimeAsync(1)

    expect(sync.calls).toEqual([])
  })

  it('runs a job that has never succeeded, which is what a fresh checkout is', async () => {
    const database = migratedDatabase()
    const sync = succeeding('sync')
    const { scheduler } = build(
      database,
      [sync.step],
      [{ job: 'sync', cron: '*/15 * * * *', chain: ['sync'] }],
    )

    scheduler.start()
    await vi.advanceTimersByTimeAsync(1)

    expect(sync.calls).toEqual(['startup'])
  })

  it('staggers the catch-up runs rather than firing everything in one second', async () => {
    const database = migratedDatabase()
    const sync = succeeding('sync')
    const purge = succeeding('purge')

    const { scheduler } = build(
      database,
      [sync.step, purge.step],
      [
        { job: 'sync', cron: '*/15 * * * *', chain: ['sync'] },
        { job: 'purge', cron: '20 3 * * *', chain: ['purge'] },
      ],
      { startupStaggerMs: 5_000 },
    )

    scheduler.start()
    await vi.advanceTimersByTimeAsync(1)
    expect([sync.calls.length, purge.calls.length]).toEqual([1, 0])

    await vi.advanceTimersByTimeAsync(5_000)
    expect([sync.calls.length, purge.calls.length]).toEqual([1, 1])
  })
})

/** Spec 06, criterion 3. */
describe('backoff after failure', () => {
  function withFailures(database: Database, count: number, lastAt: number): void {
    for (let index = 0; index < count; index += 1) {
      recordJobRun(database, {
        job: 'sync',
        trigger: 'scheduled',
        startedAt: lastAt - (count - index) * MINUTE,
        finishedAt: lastAt - (count - index - 1) * MINUTE,
        status: 'failure',
        error: 'the provider is down',
      })
    }
  }

  it('doubles the delay per consecutive failure', () => {
    const database = migratedDatabase()
    const { scheduler } = build(
      database,
      [failing('sync').step],
      [{ job: 'sync', cron: '*/15 * * * *', chain: ['sync'] }],
    )

    withFailures(database, 3, START)

    // Three failures, the last of them finished at START: base doubled twice is four minutes.
    expect(scheduler.status()[0]).toMatchObject({
      consecutiveFailures: 3,
      backoffUntil: START + 4 * MINUTE,
    })
  })

  it('stops growing at the ceiling', () => {
    const database = migratedDatabase()
    const { scheduler } = build(
      database,
      [failing('sync').step],
      [{ job: 'sync', cron: '*/15 * * * *', chain: ['sync'] }],
      { backoffCeilingMs: 10 * MINUTE },
    )

    withFailures(database, 12, START)

    expect(scheduler.status()[0]).toMatchObject({ backoffUntil: START + 10 * MINUTE })
  })

  it('is cleared by a success', () => {
    const database = migratedDatabase()
    const { scheduler } = build(
      database,
      [succeeding('sync').step],
      [{ job: 'sync', cron: '*/15 * * * *', chain: ['sync'] }],
    )

    withFailures(database, 3, START - MINUTE)
    recordJobRun(database, {
      job: 'sync',
      trigger: 'scheduled',
      startedAt: START,
      finishedAt: START,
      status: 'success',
    })

    expect(scheduler.status()[0]).toMatchObject({ consecutiveFailures: 0, backoffUntil: null })
  })

  it('holds a firing back until the delay has passed', async () => {
    const database = migratedDatabase()
    const sync = failing('sync')
    const { scheduler } = build(
      database,
      [sync.step],
      [{ job: 'sync', cron: '*/15 * * * *', chain: ['sync'] }],
      // A base longer than the cadence, so the backoff bites on the first failure rather than
      // being hidden by the schedule itself.
      { backoffBaseMs: 40 * MINUTE },
    )

    recordJobRun(database, {
      job: 'sync',
      trigger: 'scheduled',
      startedAt: START,
      finishedAt: START,
      status: 'success',
    })

    scheduler.start()
    await vi.advanceTimersByTimeAsync(15 * MINUTE)
    expect(sync.calls).toHaveLength(1)

    // The next quarter hour comes and goes: the backoff is holding it.
    await vi.advanceTimersByTimeAsync(20 * MINUTE)
    expect(sync.calls).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(25 * MINUTE)
    expect(sync.calls).toHaveLength(2)
  })

  it('does not let a skipped run break the streak or count towards it', () => {
    const database = migratedDatabase()
    const { scheduler } = build(
      database,
      [failing('sync').step],
      [{ job: 'sync', cron: '*/15 * * * *', chain: ['sync'] }],
    )

    withFailures(database, 2, START - MINUTE)
    recordJobRun(database, {
      job: 'sync',
      trigger: 'scheduled',
      startedAt: START,
      finishedAt: START,
      status: 'skipped',
    })

    expect(scheduler.status()[0]).toMatchObject({ consecutiveFailures: 2 })
  })
})

/**
 * `setTimeout` treats a delay above about 24.8 days as 1ms. Unclamped, a schedule further out than
 * that fires at once, finds nothing due, re-arms with the same overflowing delay, and spins for the
 * life of the process. Under fake timers that spin is an unfinished test rather than a busy CPU,
 * which is what makes this assertable at all.
 */
describe('a schedule further out than a timer can express', () => {
  it('waits rather than spinning', async () => {
    const database = migratedDatabase()
    const purge = succeeding('purge')
    // The 29th of February 2028, from August 2026: about eighteen months.
    const { scheduler } = build(
      database,
      [purge.step],
      [{ job: 'purge', cron: '0 3 29 2 *', chain: ['purge'] }],
    )

    recent(database, 'purge')

    scheduler.start()
    await vi.advanceTimersByTimeAsync(30 * 24 * 60 * MINUTE)

    expect(purge.calls).toEqual([])
    expect(scheduler.status()[0]?.nextRunAt).toBe(Date.UTC(2028, 1, 29, 3, 0, 0))
  })
})

describe('stopping', () => {
  it('fires nothing more once stopped', async () => {
    const database = migratedDatabase()
    const sync = succeeding('sync')
    const { scheduler } = build(
      database,
      [sync.step],
      [{ job: 'sync', cron: '*/15 * * * *', chain: ['sync'] }],
    )

    recordJobRun(database, {
      job: 'sync',
      trigger: 'scheduled',
      startedAt: START,
      finishedAt: START,
      status: 'success',
    })

    scheduler.start()
    scheduler.stop()
    await vi.advanceTimersByTimeAsync(60 * MINUTE)

    expect(sync.calls).toEqual([])
  })

  it('waits for a job in flight, and gives up rather than refusing to shut down', async () => {
    const database = migratedDatabase()
    let release: () => void = () => {}
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const held: JobStep = {
      name: 'sync',
      run: async () => {
        await blocked
        return { status: 'success' }
      },
    }

    const { scheduler } = build(database, [held], [])
    const run = scheduler.run('sync', 'manual')

    let drained = false
    const draining = scheduler.drain(5).then(() => {
      drained = true
    })

    await vi.advanceTimersByTimeAsync(10)
    await draining
    expect(drained).toBe(true)
    // Still going: waiting ended, the run did not.
    expect(scheduler.isRunning('sync')).toBe(true)

    release()
    await run
    await expect(scheduler.drain()).resolves.toBeUndefined()
  })
})

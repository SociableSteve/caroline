import { describe, expect, it } from 'vitest'
import { latestJobRun, listJobRuns, recordJobRun } from '../../../src/db/repositories/job-runs.js'
import { noCounts } from '../../../src/domain/job.js'
import { migratedDatabase } from '../../helpers/temp-database.js'

const STARTED = Date.UTC(2026, 0, 5, 9, 0)

function run(overrides: Partial<Parameters<typeof recordJobRun>[1]> = {}) {
  return {
    job: 'sync:github',
    trigger: 'scheduled' as const,
    startedAt: STARTED,
    finishedAt: STARTED + 1200,
    status: 'success' as const,
    ...overrides,
  }
}

describe('recording a job run', () => {
  it('reads back everything it was given', () => {
    const database = migratedDatabase()

    const recorded = recordJobRun(
      database,
      run({ counts: { itemsSeen: 3, tasksCreated: 2 }, trigger: 'manual' }),
    )

    expect(listJobRuns(database)).toEqual([recorded])
    expect(recorded).toMatchObject({
      job: 'sync:github',
      trigger: 'manual',
      status: 'success',
      counts: { ...noCounts, itemsSeen: 3, tasksCreated: 2 },
      error: null,
    })
  })

  it('keeps the error message and stack of a failure, which is the point of the history', () => {
    const database = migratedDatabase()

    recordJobRun(
      database,
      run({ status: 'failure', error: 'GitHub answered 401', errorStack: 'Error: 401\n  at x' }),
    )

    expect(latestJobRun(database, 'sync:github')).toMatchObject({
      status: 'failure',
      error: 'GitHub answered 401',
      errorStack: 'Error: 401\n  at x',
    })
  })

  it('defaults every count to zero, so a run that did nothing says so', () => {
    const database = migratedDatabase()

    expect(recordJobRun(database, run({ status: 'skipped' })).counts).toEqual(noCounts)
  })

  it('refuses a status the domain does not define', () => {
    const database = migratedDatabase()

    expect(() => recordJobRun(database, run({ status: 'partly' as unknown as 'success' }))).toThrow(
      /constraint/i,
    )
  })
})

describe('listing job runs', () => {
  it('answers most recent first, which is the end a history is read from', () => {
    const database = migratedDatabase()
    recordJobRun(database, run({ startedAt: STARTED }))
    recordJobRun(database, run({ startedAt: STARTED + 900_000 }))

    expect(listJobRuns(database).map((entry) => entry.startedAt)).toEqual([
      STARTED + 900_000,
      STARTED,
    ])
  })

  it('filters by job, since one connector failing is not the others failing', () => {
    const database = migratedDatabase()
    recordJobRun(database, run({ job: 'sync:github' }))
    recordJobRun(database, run({ job: 'sync:gmail', status: 'failure', error: 'no token' }))

    expect(listJobRuns(database, { job: 'sync:gmail' })).toMatchObject([{ error: 'no token' }])
  })

  it('honours the limit', () => {
    const database = migratedDatabase()
    for (let index = 0; index < 5; index += 1) {
      recordJobRun(database, run({ startedAt: STARTED + index }))
    }

    expect(listJobRuns(database, { limit: 2 })).toHaveLength(2)
  })

  it('has no latest run before anything has run', () => {
    expect(latestJobRun(migratedDatabase(), 'sync:github')).toBeNull()
  })
})

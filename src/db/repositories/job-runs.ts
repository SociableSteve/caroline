import { randomUUID } from 'node:crypto'
import type { Database } from '../connection.js'
import type { Row } from '../rows.js'
import {
  noCounts,
  type JobCounts,
  type JobRun,
  type JobRunStatus,
  type JobTrigger,
} from '../../domain/job.js'

export interface RecordJobRunInput {
  readonly job: string
  readonly trigger: JobTrigger
  readonly startedAt: number
  readonly finishedAt: number
  readonly status: JobRunStatus
  readonly counts?: Partial<JobCounts>
  readonly error?: string | null
  readonly errorStack?: string | null
}

const columns = `id, job, trigger, started_at, finished_at, status, counts, error, error_stack`

function toJobRun(row: Row): JobRun {
  const counts = row.counts
  return {
    id: String(row.id),
    job: String(row.job),
    trigger: String(row.trigger) as JobTrigger,
    startedAt: Number(row.started_at),
    finishedAt: Number(row.finished_at),
    status: String(row.status) as JobRunStatus,
    // A row written before a count existed still answers with zero rather than undefined,
    // which is what lets the UI add them up without knowing when each one was introduced.
    counts: { ...noCounts, ...(typeof counts === 'string' ? JSON.parse(counts) : {}) },
    error: row.error === null || row.error === undefined ? null : String(row.error),
    errorStack:
      row.error_stack === null || row.error_stack === undefined ? null : String(row.error_stack),
  }
}

/**
 * One row per attempt, written when the attempt ends. Every attempt writes one, including
 * the ones that did nothing: a skipped run is a fact about the schedule worth reading, and
 * a failed run is the only place the error message survives. Spec 06, criterion 5.
 */
export function recordJobRun(database: Database, input: RecordJobRunInput): JobRun {
  const run: JobRun = {
    id: randomUUID(),
    job: input.job,
    trigger: input.trigger,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    status: input.status,
    counts: { ...noCounts, ...input.counts },
    error: input.error ?? null,
    errorStack: input.errorStack ?? null,
  }

  database
    .prepare(
      `insert into job_runs (${columns}) values (
         :id, :job, :trigger, :started_at, :finished_at, :status, :counts, :error, :error_stack
       )`,
    )
    .run({
      id: run.id,
      job: run.job,
      trigger: run.trigger,
      started_at: run.startedAt,
      finished_at: run.finishedAt,
      status: run.status,
      counts: JSON.stringify(run.counts),
      error: run.error,
      error_stack: run.errorStack,
    })

  return run
}

export interface JobRunQuery {
  readonly job?: string
  readonly limit?: number
}

/** Most recent first: run history is read from the top, and the top is what went wrong. */
export function listJobRuns(database: Database, query: JobRunQuery = {}): JobRun[] {
  const where = query.job === undefined ? '' : 'where job = ?'
  const params = query.job === undefined ? [] : [query.job]

  return database
    .prepare(`select ${columns} from job_runs ${where} order by started_at desc, id limit ?`)
    .all(...params, query.limit ?? 50)
    .map((row) => toJobRun(row as Row))
}

export function latestJobRun(database: Database, job: string): JobRun | null {
  return listJobRuns(database, { job, limit: 1 })[0] ?? null
}

/**
 * The last run of this job that worked. What the scheduler measures downtime against on a cold
 * start: a job whose last success is older than one interval is due, and runs once rather than
 * once per missed slot. Spec 06, criterion 2.
 */
export function lastSuccessfulRun(database: Database, job: string): JobRun | null {
  const row = database
    .prepare(
      `select ${columns} from job_runs
       where job = ? and status = 'success'
       order by started_at desc, id limit 1`,
    )
    .get(job)

  return row === undefined ? null : toJobRun(row as Row)
}

export interface FailureStreak {
  /** How many failures in a row, most recent first, before the last success. */
  readonly count: number
  /** When the most recent of them finished, which the backoff is measured from. */
  readonly lastFailureAt: number | null
}

/**
 * The current run of failures. Skipped runs are not counted and do not break the streak: a job
 * that was skipped attempted nothing, so it is neither evidence that the trouble has passed nor
 * more of the trouble. Spec 06, criterion 3.
 */
export function failureStreak(database: Database, job: string): FailureStreak {
  const rows = database
    .prepare(
      `select status, finished_at from job_runs
       where job = ? and status in ('success', 'failure')
       order by started_at desc, id limit 100`,
    )
    .all(job)

  let count = 0
  let lastFailureAt: number | null = null

  for (const row of rows) {
    const { status, finished_at: finishedAt } = row as Row
    if (String(status) !== 'failure') break

    count += 1
    lastFailureAt ??= Number(finishedAt)
  }

  return { count, lastFailureAt }
}

/**
 * Retention for the run history. Spec 06 keeps it for a configurable window, thirty days by
 * default: a history nobody prunes becomes the largest table in the database and answers no
 * question that the last few weeks do not.
 */
export function purgeJobRunsBefore(database: Database, cutoff: number): number {
  // `changes` is a bigint on a build with big integers enabled, and a count of deleted rows is
  // never large enough for the conversion to lose anything.
  return Number(database.prepare('delete from job_runs where started_at < ?').run(cutoff).changes)
}

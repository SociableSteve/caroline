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

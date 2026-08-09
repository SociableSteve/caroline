/**
 * The record of a job attempt. Pure: the scheduler that decides when to run one arrives in
 * M5, but sync already produces these and the UI already needs to read them. Spec 06.
 */

/** Every attempt ends in one of these, including the ones that never did any work. */
export const jobRunStatuses = ['success', 'failure', 'skipped'] as const
export type JobRunStatus = (typeof jobRunStatuses)[number]

/**
 * What caused the attempt. `startup` is separate from `scheduled` because a catch-up run on
 * a cold start is a different thing to read in the history than a tick that came round.
 */
export const jobTriggers = ['scheduled', 'manual', 'startup'] as const
export type JobTrigger = (typeof jobTriggers)[number]

/**
 * What a run changed. Every field is a count and every count defaults to zero, so a job that
 * did nothing says so with zeroes rather than with an absent object.
 */
export interface JobCounts {
  /** Items the connector produced, whether or not any of them turned out to be new. */
  readonly itemsSeen: number
  readonly sourcesCreated: number
  readonly tasksCreated: number
  readonly tasksUpdated: number
  /** Items whose upstream closed on this run, so completion was proposed. */
  readonly resolved: number
  /** Inbox tasks returned to the classification queue by an upstream content change. */
  readonly requeued: number
}

export const noCounts: JobCounts = {
  itemsSeen: 0,
  sourcesCreated: 0,
  tasksCreated: 0,
  tasksUpdated: 0,
  resolved: 0,
  requeued: 0,
}

export interface JobRun {
  readonly id: string
  readonly job: string
  readonly trigger: JobTrigger
  readonly startedAt: number
  readonly finishedAt: number
  readonly status: JobRunStatus
  readonly counts: JobCounts
  /** The failure, in the words the connector used. Null on success and on a skip. */
  readonly error: string | null
  readonly errorStack: string | null
}

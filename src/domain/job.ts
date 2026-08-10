/**
 * The record of a job attempt. Pure: the scheduler decides when one happens (`src/jobs`), and this
 * is the shape of what it leaves behind for the database and the UI to share. Spec 06.
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
  /** Calendar events written or updated. They are not sources, so they have their own count. */
  readonly eventsStored: number
  /** Calendar events dropped because the pass no longer found them upstream. */
  readonly eventsRemoved: number
  /** Daily plans generated. One per run of the planner, or none when it was skipped. */
  readonly plansGenerated: number
  /** Answers the classifier received, whether applied or left as a proposal. Spec 04. */
  readonly classified: number
  /** Answers below the confidence threshold, left for the user to accept. Spec 04. */
  readonly proposals: number
  /** Model calls the run made, including the ones that failed. Spec 06. */
  readonly llmCalls: number
  /** Items the run could not process, each of which is recorded in its own right. */
  readonly failed: number
  /** Stored bodies cleared or cut back by the content purge. Spec 09, criteria 4 and 5. */
  readonly contentPurged: number
  /** `job_runs` rows dropped as older than the retention window. Spec 06. */
  readonly runsPurged: number
}

export const noCounts: JobCounts = {
  itemsSeen: 0,
  sourcesCreated: 0,
  tasksCreated: 0,
  tasksUpdated: 0,
  resolved: 0,
  requeued: 0,
  eventsStored: 0,
  eventsRemoved: 0,
  plansGenerated: 0,
  classified: 0,
  proposals: 0,
  llmCalls: 0,
  failed: 0,
  contentPurged: 0,
  runsPurged: 0,
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

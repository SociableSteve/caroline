/**
 * The task actions the API routes and the chat tools both perform. Spec 07 asks that
 * `mark_reviewed` from chat have "the same effect as the UI action", which is only reliably
 * true if there is one implementation of it rather than two that look alike.
 *
 * These do reach the database, so they are not domain code; they are the layer above it, where a
 * decision spans a task, its source and its connector's state machine. The rules themselves
 * still live in `src/domain`.
 */
import { withTransaction, type Database } from '../db/connection.js'
import { listSourcesForTask, setSourceLifecycle } from '../db/repositories/sources.js'
import { changeTaskStatus, getTask, updateTask } from '../db/repositories/tasks.js'
import { markReviewedOutcome } from '../domain/review.js'
import type { Source } from '../domain/source.js'
import type { Task, TaskStatus } from '../domain/task.js'
import { trackedStatusesFor } from '../domain/tracking.js'

/**
 * The statuses the task's connector owns, for a task sync still tracks. Passing them is what
 * makes a user filing the task outside that set a permanent opt-out. Spec 01, sync tracking.
 */
export function trackedStatuses(database: Database, task: Task): readonly TaskStatus[] | undefined {
  if (!task.syncTracked) return undefined

  for (const source of listSourcesForTask(database, task.id)) {
    const statuses = trackedStatusesFor(source.provider)
    if (statuses !== undefined) return statuses
  }

  return undefined
}

/** Where a source's state machine stood before an action moved it. What an undo needs. */
export interface SourceLifecycleSnapshot {
  readonly id: string
  readonly lifecycleState: string | null
  readonly actedAt: number | null
  readonly actedAtMarker: string | null
}

/**
 * Why marking a review done did not happen, in the terms the caller has to explain to somebody.
 * `already-reviewed` is not a failure: the review was discharged before, and answering with the
 * task as it stands makes a repeated request a no-op rather than a fresh stamp.
 */
export type MarkReviewedRefusal =
  'no-task' | 'not-a-review' | 'already-reviewed' | 'not-tracked' | 'unsynced'

export type MarkReviewedResult =
  | {
      readonly applied: true
      readonly task: Task
      /** Where the state machine was, so an undo can put it back. */
      readonly previous: SourceLifecycleSnapshot
    }
  | { readonly applied: false; readonly reason: MarkReviewedRefusal }

/**
 * Discharging your part of a review: the task moves to Waiting for, named on the author, and the
 * source records when you acted and where upstream was when you did. That marker is what stops
 * the next sync, fifteen minutes later, seeing a standing review request and pulling the card
 * straight back into Review. Spec 02, criteria 10 and 11.
 *
 * The status change is attributed to `sync` rather than to the user, because it is a move within
 * the connector's own state machine rather than a decision to file the task somewhere: the user
 * supplied the input, the machine made the move. Filing it somewhere is what a status change
 * does, and that is the user's.
 */
export function markTaskReviewed(database: Database, id: string, now: number): MarkReviewedResult {
  const task = getTask(database, id)
  if (task === null) return { applied: false, reason: 'no-task' }

  const source = listSourcesForTask(database, id).find(
    (candidate) => candidate.provider === 'github' && candidate.resolvedAt === null,
  )
  if (source === undefined) return { applied: false, reason: 'not-a-review' }

  // Already discharged. Re-marking would move `acted_at` to now and the marker to the current
  // head, which would quietly swallow whatever the author pushed between the two requests. Spec
  // 02, criterion 11 is the same rule from the other side.
  if (source.lifecycleState !== 'awaiting_review') {
    return { applied: false, reason: 'already-reviewed' }
  }

  if (!task.syncTracked) return { applied: false, reason: 'not-tracked' }

  const metadata = source.metadata as { headSha?: unknown; author?: unknown } | null
  const headSha = metadata?.headSha
  if (typeof headSha !== 'string') return { applied: false, reason: 'unsynced' }

  const outcome = markReviewedOutcome(headSha, now)

  const updated = withTransaction(database, () => {
    setSourceLifecycle(database, source.id, outcome.state, { at: now, marker: headSha })
    changeTaskStatus(database, id, { status: outcome.status, by: 'sync', at: now })
    return updateTask(
      database,
      id,
      { waitingOn: typeof metadata?.author === 'string' ? metadata.author : null },
      now,
    )
  })

  return {
    applied: true,
    // The write went through in the transaction above, so a null here is not a case.
    task: updated ?? task,
    previous: lifecycleSnapshot(source),
  }
}

export function lifecycleSnapshot(source: Source): SourceLifecycleSnapshot {
  return {
    id: source.id,
    lifecycleState: source.lifecycleState,
    actedAt: source.actedAt,
    actedAtMarker: source.actedAtMarker,
  }
}

/**
 * What is outstanding, on whom, and for how long. The planner turns these into the daily plan's
 * nudges (spec 05) and chat's `list_waiting` tool answers chase questions from them (spec 07),
 * so the dating rule is read from one place: two answers to "how long has this been waiting"
 * would be two answers to "is this stale", and the second one would be wrong on some day.
 */
import type { Database } from '../db/connection.js'
import { listSourcesForTasks } from '../db/repositories/sources.js'
import type { WaitingItem } from '../domain/plan.js'
import { hasNewCommitsSinceActing } from '../domain/review.js'
import type { Source } from '../domain/source.js'
import type { Task } from '../domain/task.js'
import { waitingSince } from '../domain/waiting.js'

/** The waiting items among these tasks, each dated from the moment it became somebody else's turn. */
export function waitingItems(
  tasks: readonly Task[],
  sources: ReadonlyMap<string, Source[]>,
): WaitingItem[] {
  return tasks
    .filter((task) => task.status === 'waiting')
    .map((task) => {
      const pullRequest = (sources.get(task.id) ?? []).find(
        (source) => source.provider === 'github',
      )
      const metadata = (pullRequest?.metadata ?? {}) as {
        headSha?: unknown
        headCommittedAt?: unknown
      }

      return {
        taskId: task.id,
        title: task.title,
        waitingOn: task.waitingOn,
        waitingSince: waitingSince(task, pullRequest ?? null),
        isPullRequest: pullRequest !== undefined,
        // The state machine's own judgement, imported rather than reimplemented, so the nudge
        // and the card cannot come to different conclusions about the same two shas.
        pushedSinceReview:
          pullRequest !== undefined && typeof metadata.headSha === 'string'
            ? hasNewCommitsSinceActing(
                {
                  headSha: metadata.headSha,
                  headCommittedAt:
                    typeof metadata.headCommittedAt === 'number' ? metadata.headCommittedAt : null,
                },
                pullRequest,
              )
            : false,
      }
    })
}

/** The same, read from the database for a set of tasks the caller has already listed. */
export function waitingItemsFor(database: Database, tasks: readonly Task[]): WaitingItem[] {
  return waitingItems(
    tasks,
    listSourcesForTasks(
      database,
      tasks.map((task) => task.id),
    ),
  )
}

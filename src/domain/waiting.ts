/**
 * How long an item has been waiting on somebody else, and when that becomes a chase.
 *
 * Spec 02 states the rule once: the age of a waiting item is measured from `acted_at` where
 * there is a source, and from `status_set_at` where there is not, because for a manually
 * created waiting task that is the same moment said a different way. Three surfaces read it,
 * so it lives in the domain rather than in any of them: the Waiting for column and the
 * dashboard chase list (spec 08), and the daily plan's nudges (spec 05).
 *
 * Pure, and the shapes are structural rather than the whole `Task` and `Source`, so the
 * client can use it over what the API returned without reconstructing a row.
 */

const DAY_MS = 24 * 60 * 60_000

/** Enough of a task to date its wait. */
export interface WaitingTask {
  readonly statusSetAt: number
}

/** Enough of the source behind it, where there is one. */
export interface WaitingSource {
  readonly actedAt: number | null
}

export function waitingSince(task: WaitingTask, source: WaitingSource | null | undefined): number {
  return source?.actedAt ?? task.statusSetAt
}

export function waitingAge(
  task: WaitingTask,
  source: WaitingSource | null | undefined,
  now: number,
): number {
  return Math.max(0, now - waitingSince(task, source))
}

/**
 * Past the configured threshold, a waiting item stops being tracked and becomes a chase. At
 * the threshold exactly it has crossed it: seven days means seven, not seven and a bit.
 */
export function isStaleWait(
  task: WaitingTask,
  source: WaitingSource | null | undefined,
  now: number,
  staleDays: number,
): boolean {
  return waitingAge(task, source, now) >= staleDays * DAY_MS
}

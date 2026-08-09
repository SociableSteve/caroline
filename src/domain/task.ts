/**
 * The task entity and the rules that constrain its status. Pure: no database, no clock, no
 * randomness. Callers pass `id` and `at`, which is what makes every rule here testable
 * without a fixture. Spec 01.
 */

/**
 * Seven, fixed. `project` is deliberately absent: a project is a separate entity that owns
 * tasks, not a bucket of tasks pretending to be one.
 */
export const taskStatuses = [
  'inbox',
  'next_action',
  'review',
  'waiting',
  'someday',
  'reference',
  'done',
] as const
export type TaskStatus = (typeof taskStatuses)[number]

/** Who last set a status. `user` is the one that locks the classifier out. */
export const statusActors = ['user', 'llm', 'sync'] as const
export type StatusActor = (typeof statusActors)[number]

/**
 * The statuses the GitHub connector owns transitions within, per spec 02. Each connector
 * declares its own set; it is passed in rather than looked up so that domain code never
 * needs to know which connectors exist.
 */
export const githubTrackedStatuses: readonly TaskStatus[] = ['review', 'waiting', 'done']

export interface Task {
  readonly id: string
  readonly title: string
  readonly notes: string | null
  readonly status: TaskStatus
  readonly projectId: string | null
  readonly sortOrder: number
  readonly estimateMinutes: number | null
  readonly dueAt: number | null
  readonly deferUntil: number | null
  readonly waitingOn: string | null
  readonly statusSetBy: StatusActor
  readonly statusSetAt: number
  readonly syncTracked: boolean
  readonly createdAt: number
  readonly updatedAt: number
  readonly completedAt: number | null
}

export interface NewTaskInput {
  readonly id: string
  readonly title: string
  readonly notes?: string | null
  readonly status?: TaskStatus
  readonly statusSetBy?: StatusActor
  readonly projectId?: string | null
  readonly sortOrder?: number
  readonly estimateMinutes?: number | null
  readonly dueAt?: number | null
  readonly deferUntil?: number | null
  readonly waitingOn?: string | null
}

/**
 * A task with no status is captured, not decided, so it lands in the inbox attributed to
 * the user. A task sync creates starts tracked; anything else does not, since there is no
 * lifecycle upstream to follow.
 */
export function newTask(input: NewTaskInput, now: number): Task {
  const statusSetBy = input.statusSetBy ?? 'user'

  return {
    id: input.id,
    title: input.title,
    notes: input.notes ?? null,
    status: input.status ?? 'inbox',
    projectId: input.projectId ?? null,
    sortOrder: input.sortOrder ?? 0,
    estimateMinutes: input.estimateMinutes ?? null,
    dueAt: input.dueAt ?? null,
    deferUntil: input.deferUntil ?? null,
    waitingOn: input.waitingOn ?? null,
    statusSetBy,
    statusSetAt: now,
    syncTracked: statusSetBy === 'sync',
    createdAt: now,
    updatedAt: now,
    completedAt: input.status === 'done' ? now : null,
  }
}

export interface StatusChange {
  readonly status: TaskStatus
  readonly by: StatusActor
  readonly at: number
  /** The statuses the owning connector controls. Only consulted for tracked tasks. */
  readonly trackedStatuses?: readonly TaskStatus[]
}

/** Why a change was refused, so a caller can record the proposal instead of applying it. */
export type StatusChangeRefusal = 'user-set' | 'not-tracked'

export type StatusChangeResult =
  | { readonly applied: true; readonly task: Task }
  | { readonly applied: false; readonly reason: StatusChangeRefusal; readonly task: Task }

/**
 * Any status can follow any other, because GTD triage is genuinely free-form. Two rules
 * constrain who may do it:
 *
 * - The classifier never touches a task the user has decided on.
 * - Sync only touches tasks it still tracks, and the user moving a tracked task out of its
 *   connector's set is a permanent opt-out.
 *
 * Returns the unchanged task alongside the refusal rather than throwing, so the caller can
 * record the rejected proposal.
 */
export function applyStatusChange(task: Task, change: StatusChange): StatusChangeResult {
  if (change.by === 'llm' && task.statusSetBy === 'user') {
    return { applied: false, reason: 'user-set', task }
  }

  if (change.by === 'sync' && !task.syncTracked) {
    return { applied: false, reason: 'not-tracked', task }
  }

  return {
    applied: true,
    task: {
      ...task,
      status: change.status,
      statusSetBy: change.by,
      statusSetAt: change.at,
      syncTracked: nextSyncTracked(task, change),
      completedAt: change.status === 'done' ? change.at : null,
      updatedAt: change.at,
    },
  }
}

/**
 * Tracking only ever goes from true to false here. Re-enabling is an explicit action from
 * the UI, never a side effect of moving a task back into the tracked set: opting out is
 * permanent until the user says otherwise.
 */
function nextSyncTracked(task: Task, change: StatusChange): boolean {
  if (!task.syncTracked) return false
  if (change.by !== 'user') return true

  // A caller that did not name the connector's set has not expressed an opt-out, and an
  // opt-out is permanent, so tracking stands rather than being dropped by omission.
  if (change.trackedStatuses === undefined) return true

  return change.trackedStatuses.includes(change.status)
}

/** Re-enables the lifecycle the user previously opted out of. Spec 01, sync tracking. */
export function enableSyncTracking(task: Task, at: number): Task {
  return { ...task, syncTracked: true, updatedAt: at }
}

/**
 * A deferred task is hidden from Next actions and from daily planning until the moment
 * passes. `deferUntil` equal to now has passed, so the task is visible.
 */
export function isDeferred(task: Pick<Task, 'deferUntil'>, now: number): boolean {
  return task.deferUntil !== null && task.deferUntil > now
}

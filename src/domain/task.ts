/**
 * The task entity and the rules that constrain its status. Pure: no database, no clock, no
 * randomness. Callers pass `id` and `at`, which is what makes every rule here testable
 * without a fixture. Spec 01.
 */

/**
 * Eight, fixed. `project` is deliberately absent: a project is a separate entity that owns
 * tasks, not a bucket of tasks pretending to be one.
 *
 * `waiting` is a person and `blocked` is a task of your own. That is the whole of the difference
 * between them, and the order here is the order the board draws its columns in, so `blocked` sits
 * beside the other state whose next move is not yours.
 */
export const taskStatuses = [
  'inbox',
  'next_action',
  'review',
  'waiting',
  'blocked',
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
  /**
   * The task that has to finish before this one can start. Not null exactly when `status` is
   * `blocked`: the two are one fact, and the schema refuses the disagreement. Spec 01,
   * criterion 12.
   */
  readonly blockedBy: string | null
  readonly statusSetBy: StatusActor
  readonly statusSetAt: number
  /** What `status` was before the most recent change, so that change can be put back. */
  readonly previousStatus: TaskStatus | null
  /** What `statusSetBy` was at the same moment. Null together with `previousStatus`. */
  readonly previousStatusSetBy: StatusActor | null
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
  /** Naming one here creates the task `blocked`, whatever `status` says. Spec 01, criterion 13. */
  readonly blockedBy?: string | null
}

/**
 * A task with no status is captured, not decided, so it lands in the inbox attributed to
 * the user. A task sync creates starts tracked; anything else does not, since there is no
 * lifecycle upstream to follow.
 */
export function newTask(input: NewTaskInput, now: number): Task {
  const statusSetBy = input.statusSetBy ?? 'user'
  // The status and the blocker are one fact, so the two are resolved together rather than taken
  // as given: a blocker names a blocked task, and a task that is not blocked holds no blocker.
  // Spec 01, criterion 12.
  const blockedBy = input.blockedBy ?? null
  const status = blockedBy === null ? (input.status ?? 'inbox') : 'blocked'

  return {
    id: input.id,
    title: input.title,
    notes: input.notes ?? null,
    status,
    projectId: input.projectId ?? null,
    sortOrder: input.sortOrder ?? 0,
    estimateMinutes: input.estimateMinutes ?? null,
    dueAt: input.dueAt ?? null,
    deferUntil: input.deferUntil ?? null,
    waitingOn: input.waitingOn ?? null,
    blockedBy,
    statusSetBy,
    statusSetAt: now,
    // Never changed, so there is nothing to put back. Spec 01, criterion 11.
    previousStatus: null,
    previousStatusSetBy: null,
    syncTracked: statusSetBy === 'sync',
    createdAt: now,
    updatedAt: now,
    completedAt: status === 'done' ? now : null,
  }
}

export interface StatusChange {
  readonly status: TaskStatus
  readonly by: StatusActor
  readonly at: number
  /** The statuses the owning connector controls. Only consulted for tracked tasks. */
  readonly trackedStatuses?: readonly TaskStatus[]
  /**
   * Required with a status of `blocked` and ignored with any other, because the status and the
   * reference are one fact. `blockChange` below is the way to build both halves at once.
   */
  readonly blockedBy?: string | null
}

/** Why a change was refused, so a caller can record the proposal instead of applying it. */
export type StatusChangeRefusal = 'user-set' | 'not-tracked' | 'blocker-required'

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

  // Spec 01, criterion 12. A move to `blocked` with nothing to be blocked behind is half a fact,
  // and the schema would refuse the row anyway; refusing it here means the caller is told why
  // rather than handed a constraint violation.
  const blockedBy = change.status === 'blocked' ? (change.blockedBy ?? null) : null
  if (change.status === 'blocked' && blockedBy === null) {
    return { applied: false, reason: 'blocker-required', task }
  }

  return {
    applied: true,
    task: {
      ...task,
      status: change.status,
      // Cleared by any move out of `blocked`, which is what makes unblocking one way: the
      // reference goes with the status, and naming it again is a new decision. Criterion 16.
      blockedBy,
      statusSetBy: change.by,
      statusSetAt: change.at,
      // One step, not a history: each change overwrites the pair, so what is recoverable is the
      // last change and nothing before it. Spec 01, criterion 8.
      previousStatus: task.status,
      previousStatusSetBy: task.statusSetBy,
      syncTracked: nextSyncTracked(task, change),
      completedAt: change.status === 'done' ? change.at : null,
      updatedAt: change.at,
    },
  }
}

/**
 * Why a change could not be put back. `nothing-to-undo` is a task never changed since it was
 * created; `blocked-needs-blocker` is a move out of `blocked`, whose reference went with the
 * move and cannot be invented back. Spec 01, criteria 11 and 18.
 */
export type UndoRefusal = 'nothing-to-undo' | 'blocked-needs-blocker'

export type UndoStatusResult =
  | { readonly undone: true; readonly task: Task }
  | { readonly undone: false; readonly reason: UndoRefusal }

/**
 * Putting the last status change back. It restores the actor as well as the status, which is the
 * half that matters: a board move records `status_set_by = 'user'` and takes the task out of the
 * classifier's reach for good, so a move made by mistake that only had its status restored would
 * leave the classifier locked out and the undo would not have undone the part that cost anything.
 * Spec 01, criterion 9.
 *
 * Undo is not itself a status change for the purpose of the previous pair: it clears it rather
 * than recording what it undid, because recording it would make undo a toggle and lose the thing
 * being restored. Criterion 10.
 *
 * Undoing a move that put a task *into* `blocked` clears the blocker along with the status, for
 * the same reason every other move out of the column does: the pair is one fact, and putting the
 * status back while keeping the reference would leave half of one. Spec 01, criterion 20.
 *
 * Sync tracking is deliberately untouched. Opting out is permanent until the user re-enables it,
 * and there is an explicit action for that; guessing at it here would re-enable a lifecycle they
 * may have turned off deliberately several changes ago.
 */
export function undoStatusChange(task: Task, at: number): UndoStatusResult {
  const { previousStatus, previousStatusSetBy } = task
  if (previousStatus === null || previousStatusSetBy === null) {
    return { undone: false, reason: 'nothing-to-undo' }
  }

  // The blocker was cleared by the move being put back, and the status cannot stand without one.
  // Refused rather than restored from a remembered id, because spec 01 has unblocking one way:
  // the second block is a new decision rather than the resumption of an old one. Criterion 18.
  if (previousStatus === 'blocked') return { undone: false, reason: 'blocked-needs-blocker' }

  return {
    undone: true,
    task: {
      ...task,
      status: previousStatus,
      // The status being put back is never `blocked`, refused just above, so the reference goes
      // with it: undoing a move into the column is a move out of it like any other, and leaving
      // the reference behind would be half a fact the schema refuses anyway. Spec 01, criterion 20.
      blockedBy: null,
      statusSetBy: previousStatusSetBy,
      statusSetAt: at,
      previousStatus: null,
      previousStatusSetBy: null,
      completedAt: previousStatus === 'done' ? at : null,
      updatedAt: at,
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

  // Blocking is transparent to tracking, and it is the one status outside a connector's set that
  // is. Naming a blocker says this cannot start yet, not that the connector's lifecycle is
  // unwanted, and it takes nothing away from the connector while it lasts, because a connector
  // owns transitions only for a task currently inside its own set. Spending a permanent opt-out
  // on a temporary state would detach a pull request from GitHub for good on the strength of a
  // dropdown. Answered here rather than at the write paths so that both spellings of the act,
  // naming the blocker alone and naming the status with it, cannot answer it differently.
  // Spec 01, criterion 21.
  if (change.status === 'blocked') return true
  // The same move undone. Leaving `blocked` for anything else is an ordinary filing decision and
  // still opts out; `next_action` is where a cleared blocker puts the task, so it is not one.
  if (task.status === 'blocked' && change.status === 'next_action') return true

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
 * A task nobody has decided on: still in the inbox, and not put there by the user. It is the same
 * question the classifier asks when it picks candidates, and `listClassificationCandidates` asks it
 * in SQL for the same reason: `status = 'inbox' and status_set_by != 'user'`.
 *
 * What it licenses is narrow. Sync may retire an untriaged task that turned out to be a duplicate
 * of something already on the board (spec 02, backup sources); it may never touch a triaged one,
 * because that status is a decision somebody made.
 */
export function isUntriaged(task: Pick<Task, 'status' | 'statusSetBy'>): boolean {
  return task.status === 'inbox' && task.statusSetBy !== 'user'
}

/**
 * A deferred task is hidden from Next actions and from daily planning until the moment
 * passes. `deferUntil` equal to now has passed, so the task is visible.
 */
export function isDeferred(task: Pick<Task, 'deferUntil'>, now: number): boolean {
  return task.deferUntil !== null && task.deferUntil > now
}

/**
 * Naming a blocker is a move to `blocked`, and clearing one is a move back to `next_action`,
 * which is what an unblocked concrete action is. Built here rather than at each write path so
 * that the two halves of the fact are never sent separately. Spec 01, criterion 13.
 */
export function blockChange(blockedBy: string | null, by: StatusActor, at: number): StatusChange {
  return blockedBy === null
    ? { status: 'next_action', by, at }
    : { status: 'blocked', by, at, blockedBy }
}

/** Why naming a blocker was refused. Self-reference is the degenerate case of a cycle. */
export type BlockRefusal = 'cycle'

/**
 * Whether blocking `taskId` behind `blockerId` would put the task behind itself, directly or
 * through a chain. Pure: the caller supplies `blockerOf`, which answers what one task is blocked
 * by, so the rule is testable without a database and every write path asks the same question.
 * Spec 01, criterion 17.
 *
 * The walk is up a single chain, which terminates on the invariant it maintains. It carries the
 * ids it has seen all the same, so a database edited by hand into a loop cannot hang the process.
 */
export function blockRefusal(
  taskId: string,
  blockerId: string,
  blockerOf: (id: string) => string | null,
): BlockRefusal | null {
  const seen = new Set<string>()
  let current: string | null = blockerId

  while (current !== null) {
    if (current === taskId) return 'cycle'
    if (seen.has(current)) return null
    seen.add(current)
    current = blockerOf(current)
  }

  return null
}

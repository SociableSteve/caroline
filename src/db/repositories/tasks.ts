import { randomUUID } from 'node:crypto'
import { withTransaction, type Database } from '../connection.js'
import { booleanToInteger, toTask, type Row } from '../rows.js'
import {
  applyStatusChange,
  blockChange,
  blockRefusal,
  enableSyncTracking,
  newTask,
  type BlockRefusal,
  type NewTaskInput,
  type StatusChange,
  type StatusChangeRefusal,
  type StatusChangeResult,
  type Task,
  type TaskStatus,
  type UndoRefusal,
  undoStatusChange,
} from '../../domain/task.js'

export interface CreateTaskInput extends Omit<NewTaskInput, 'id'> {
  /** Supply one to make a test deterministic; otherwise a uuid is generated. */
  readonly id?: string
}

/** Fields a plain edit may change. Status is deliberately absent: see `changeTaskStatus`. */
export interface TaskPatch {
  readonly title?: string
  readonly notes?: string | null
  readonly projectId?: string | null
  readonly sortOrder?: number
  readonly estimateMinutes?: number | null
  readonly dueAt?: number | null
  readonly deferUntil?: number | null
  readonly waitingOn?: string | null
}

const columns = `id, title, notes, status, project_id, sort_order, estimate_minutes, due_at,
  defer_until, waiting_on, blocked_by, status_set_by, status_set_at, previous_status,
  previous_status_set_by, sync_tracked, created_at, updated_at, completed_at`

/** Manual ordering first, then stable tiebreaks so a list never reshuffles between reads. */
const ordering = 'order by sort_order, created_at, id'

function writeTask(database: Database, task: Task): void {
  database
    .prepare(
      `insert into tasks (${columns}) values (
         :id, :title, :notes, :status, :project_id, :sort_order, :estimate_minutes, :due_at,
         :defer_until, :waiting_on, :blocked_by, :status_set_by, :status_set_at, :previous_status,
         :previous_status_set_by, :sync_tracked, :created_at, :updated_at, :completed_at
       )
       on conflict (id) do update set
         title = excluded.title,
         notes = excluded.notes,
         status = excluded.status,
         project_id = excluded.project_id,
         sort_order = excluded.sort_order,
         estimate_minutes = excluded.estimate_minutes,
         due_at = excluded.due_at,
         defer_until = excluded.defer_until,
         waiting_on = excluded.waiting_on,
         blocked_by = excluded.blocked_by,
         status_set_by = excluded.status_set_by,
         status_set_at = excluded.status_set_at,
         previous_status = excluded.previous_status,
         previous_status_set_by = excluded.previous_status_set_by,
         sync_tracked = excluded.sync_tracked,
         updated_at = excluded.updated_at,
         completed_at = excluded.completed_at`,
    )
    .run({
      id: task.id,
      title: task.title,
      notes: task.notes,
      status: task.status,
      project_id: task.projectId,
      sort_order: task.sortOrder,
      estimate_minutes: task.estimateMinutes,
      due_at: task.dueAt,
      defer_until: task.deferUntil,
      waiting_on: task.waitingOn,
      blocked_by: task.blockedBy,
      status_set_by: task.statusSetBy,
      status_set_at: task.statusSetAt,
      previous_status: task.previousStatus,
      previous_status_set_by: task.previousStatusSetBy,
      sync_tracked: booleanToInteger(task.syncTracked),
      created_at: task.createdAt,
      updated_at: task.updatedAt,
      completed_at: task.completedAt,
    })
}

/**
 * Writes a whole task row as given, attribution and timestamps included. The one caller is
 * chat's undo, which holds the row as it was before a turn touched it and has to put exactly
 * that back: going through `updateTask` would stamp `updated_at` with the moment of the undo and
 * leave the task looking edited rather than restored. Spec 07, criterion 5.
 */
export function restoreTask(database: Database, task: Task): void {
  writeTask(database, task)
}

export function createTask(database: Database, input: CreateTaskInput, now: number): Task {
  const task = newTask({ ...input, id: input.id ?? randomUUID() }, now)
  writeTask(database, task)
  return task
}

export function getTask(database: Database, id: string): Task | null {
  const row = database.prepare(`select ${columns} from tasks where id = ?`).get(id)
  return row === undefined ? null : toTask(row as Row)
}

export function listTasksByStatus(database: Database, status: TaskStatus): Task[] {
  return database
    .prepare(`select ${columns} from tasks where status = ? ${ordering}`)
    .all(status)
    .map((row) => toTask(row as Row))
}

export function listProjectTasks(database: Database, projectId: string): Task[] {
  return database
    .prepare(`select ${columns} from tasks where project_id = ? ${ordering}`)
    .all(projectId)
    .map((row) => toTask(row as Row))
}

/**
 * The Next actions view. A task deferred past `now` is hidden until the moment arrives,
 * which is the whole point of `defer_until`. Spec 01, criterion 5.
 */
export function listNextActions(database: Database, now: number): Task[] {
  return database
    .prepare(
      `select ${columns} from tasks
       where status = 'next_action' and (defer_until is null or defer_until <= ?)
       ${ordering}`,
    )
    .all(now)
    .map((row) => toTask(row as Row))
}

/**
 * What the classifier is allowed to look at: inbox tasks the user has not decided on, oldest
 * first, capped by the caller's batch size. Spec 04, criteria 1 and 8.
 *
 * A task the user has touched is never a candidate, even while it sits in the inbox: leaving
 * something there on purpose is a decision.
 *
 * A task the classifier has already answered about is not a candidate either, unless the item
 * has changed upstream since. Three cases arrive at the same rule:
 *
 * - A proposal below the threshold is on the screen waiting for the user. Asking again would
 *   spend a call to produce the same row.
 * - A proposal the user dismissed was a decision to leave the task where it is.
 * - A confident answer of `inbox` is the model saying it does not know, which spec 04 asks it to
 *   prefer over a confident wrong guess. Without this the task would be asked about every hour
 *   for as long as it sat there.
 *
 * A row that failed does not count, because nothing was answered: the next run retries it. What
 * makes a task a candidate again is an upstream change, which is what `requeued_at` records.
 */
export function listClassificationCandidates(database: Database, limit: number): Task[] {
  return database
    .prepare(
      `select ${columns} from tasks
       where status = 'inbox' and status_set_by != 'user'
         and not exists (
           select 1 from classifications
           where classifications.task_id = tasks.id
             and classifications.error is null
             and classifications.created_at >= coalesce(
               (select max(requeued_at) from sources where sources.task_id = tasks.id), 0
             )
         )
       order by created_at, id
       limit ?`,
    )
    .all(limit)
    .map((row) => toTask(row as Row))
}

/**
 * The only way a status changes. The domain decides whether the change is allowed; this
 * writes the result if it is. Returns null when there is no such task, and an unapplied
 * result when the rules refused it, so a caller can record the rejected proposal.
 */
export function changeTaskStatus(
  database: Database,
  id: string,
  change: StatusChange,
): StatusChangeResult | null {
  const existing = getTask(database, id)
  if (existing === null) return null

  const result = applyStatusChange(existing, change)
  if (!result.applied) return result

  // One transaction, because completing a blocker is two writes that have to be one fact: the task
  // finishes and what was behind it is released. Spec 01, criterion 14.
  withTransaction(database, () => {
    writeTask(database, result.task)
    if (result.task.status === 'done') releaseBlockedBy(database, id, change.at)
  })

  return result
}

/** The tasks blocked behind this one. Empty for almost every task, and indexed for the rest. */
export function listBlockedBy(database: Database, blockerId: string): Task[] {
  return database
    .prepare(`select ${columns} from tasks where blocked_by = ? ${ordering}`)
    .all(blockerId)
    .map((row) => toTask(row as Row))
}

/**
 * Releases everything blocked behind a task that is finishing or going: each dependent loses its
 * reference and becomes a next action again. Attributed to `user`, because the act that caused it
 * is the user completing or deleting the blocker and there is no other actor in the story, and
 * because that keeps the classifier locked out of a task the user had already decided on.
 * Spec 01, criteria 14 and 15.
 *
 * One way only. Reopening a completed blocker does not re-block anything, because the reference
 * went when it completed, and naming it again is a new decision. Criterion 16.
 */
function releaseBlockedBy(database: Database, blockerId: string, at: number): void {
  for (const dependent of listBlockedBy(database, blockerId)) {
    const released = applyStatusChange(dependent, blockChange(null, 'user', at))
    if (released.applied) writeTask(database, released.task)
  }
}

/** Why naming a blocker was refused, in the words a route or a tool can turn into a message. */
export type BlockerRefusal = 'not-found' | 'no-such-blocker' | 'blocker-done' | BlockRefusal

export type BlockerResult =
  | { readonly ok: true; readonly task: Task }
  | { readonly ok: false; readonly reason: BlockerRefusal }

/**
 * Whether naming this blocker would be refused, and why. A read, so a caller can answer before it
 * writes anything and leave the task exactly as it was. Spec 01, criteria 17 and 19.
 *
 * The chain is read from the database and the rule is applied in the domain, so every write path
 * asks the same question and none of them can answer it differently.
 *
 * `id` is null on the create path, where the task being blocked does not exist yet. Everything but
 * the cycle walk still applies, and a task nothing points at cannot be in a cycle, so the one check
 * that needs an id is the one skipped.
 */
export function blockerRefusal(
  database: Database,
  id: string | null,
  blockedBy: string | null,
): BlockerRefusal | null {
  if (id !== null && getTask(database, id) === null) return 'not-found'
  if (blockedBy === null) return null

  const blocker = getTask(database, blockedBy)
  if (blocker === null) return 'no-such-blocker'
  // Nothing would ever release it. `releaseBlockedBy` fires on the transition to `done`, and that
  // moment has passed, so a task filed behind finished work sits in the Blocked column until
  // somebody notices. Spec 01, criterion 19.
  if (blocker.status === 'done') return 'blocker-done'

  if (id === null) return null

  return blockRefusal(id, blockedBy, (of) => getTask(database, of)?.blockedBy ?? null)
}

/**
 * Naming the task that has to finish first, or clearing it. The one way the pair is set, because
 * the status and the reference are one fact and a caller that could set them separately could set
 * them apart. Spec 01, criteria 12, 13 and 17.
 */
export function setTaskBlocker(
  database: Database,
  id: string,
  blockedBy: string | null,
  at: number,
): BlockerResult {
  const refused = blockerRefusal(database, id, blockedBy)
  if (refused !== null) return { ok: false, reason: refused }

  const result = changeTaskStatus(database, id, blockChange(blockedBy, 'user', at))
  if (result === null) return { ok: false, reason: 'not-found' }

  if (!result.applied) {
    // Unreachable as the rules stand: `blockChange` builds both halves of the fact, and the two
    // other refusals are the classifier's and sync's rather than the user's. Raised rather than
    // reported as one of the refusals above, because a rule that has grown a case this was not
    // told about is a defect and should read as one.
    throw new Error(`the status rules refused a user block of ${id}: ${result.reason}`)
  }

  return { ok: true, task: result.task }
}

/**
 * Puts the last status change back, the actor with it. Returns null where there is no such task,
 * and the unchanged task where there is nothing to put back, so a route can tell a 404 from a 409.
 * Spec 01, criteria 9 to 11.
 */
export function undoTaskStatus(
  database: Database,
  id: string,
  at: number,
):
  | { readonly undone: true; readonly task: Task }
  | { readonly undone: false; readonly reason: UndoRefusal; readonly task: Task }
  | null {
  const existing = getTask(database, id)
  if (existing === null) return null

  const result = undoStatusChange(existing, at)
  if (!result.undone) return { undone: false, reason: result.reason, task: existing }

  // Putting a completion back is still a completion arriving at the row, so what was blocked
  // behind it is released here too. Spec 01, criterion 14.
  withTransaction(database, () => {
    writeTask(database, result.task)
    if (result.task.status === 'done') releaseBlockedBy(database, id, at)
  })

  return { undone: true, task: result.task }
}

/** Turns the connector's lifecycle back on after the user opted out. Spec 01. */
export function setSyncTracking(
  database: Database,
  id: string,
  enabled: boolean,
  now: number,
): Task | null {
  const existing = getTask(database, id)
  if (existing === null) return null

  const task = enabled
    ? enableSyncTracking(existing, now)
    : { ...existing, syncTracked: false, updatedAt: now }
  writeTask(database, task)

  return task
}

export function updateTask(
  database: Database,
  id: string,
  patch: TaskPatch,
  now: number,
): Task | null {
  const existing = getTask(database, id)
  if (existing === null) return null

  // Absent keys do not appear in the spread, and `exactOptionalPropertyTypes` stops a
  // caller passing an explicit undefined, so this leaves untouched fields untouched.
  const updated: Task = { ...existing, ...patch, updatedAt: now }
  writeTask(database, updated)

  return updated
}

/**
 * Hard delete. Almost always an explicit user action, and never sync deciding a piece of work is
 * over: sync resolves and proposes, it does not delete. Spec 01.
 *
 * The one exception is retiring an untriaged task that turned out to be a duplicate of something
 * already on the board, which is a card that should never have existed rather than work being
 * thrown away. Its source row survives and moves to the task that owns the work, so the provenance
 * is kept. Spec 02, notification emails as a backup source.
 */
export function deleteTask(database: Database, id: string, at: number): boolean {
  return withTransaction(database, () => {
    // Before the delete and in the same transaction. `on delete set null` on the column would
    // null the reference on its own and leave the status saying `blocked`, which the invariant
    // forbids, so the status has to move with it. Spec 01, criterion 15.
    releaseBlockedBy(database, id, at)
    return database.prepare('delete from tasks where id = ?').run(id).changes > 0
  })
}

/** Replaces the task's whole tag set. Repeats are ignored rather than failing the write. */
export function setTaskTags(database: Database, taskId: string, tags: readonly string[]): void {
  withTransaction(database, () => {
    database.prepare('delete from task_tags where task_id = ?').run(taskId)
    const insert = database.prepare('insert or ignore into task_tags (task_id, tag) values (?, ?)')
    for (const tag of tags) insert.run(taskId, tag)
  })
}

export function getTaskTags(database: Database, taskId: string): string[] {
  return database
    .prepare('select tag from task_tags where task_id = ? order by tag')
    .all(taskId)
    .map((row) => String((row as Row).tag))
}

/**
 * The tags of several tasks in one query, so listing a board does not run a query per card.
 * A task with no tags is absent from the map rather than present with an empty array: the
 * caller defaults it, and the distinction never matters.
 */
export function listTags(database: Database, taskIds: readonly string[]): Map<string, string[]> {
  const tags = new Map<string, string[]>()
  if (taskIds.length === 0) return tags

  const placeholders = taskIds.map(() => '?').join(', ')
  const rows = database
    .prepare(`select task_id, tag from task_tags where task_id in (${placeholders}) order by tag`)
    .all(...taskIds)

  for (const row of rows) {
    const taskId = String((row as Row).task_id)
    const existing = tags.get(taskId)
    if (existing === undefined) {
      tags.set(taskId, [String((row as Row).tag)])
    } else {
      existing.push(String((row as Row).tag))
    }
  }

  return tags
}

/**
 * How many tasks are in each status. The dashboard counts its own from the list it already has;
 * this is for chat, which is given the counts as context on every turn and must not read the
 * whole table to get them. Spec 07.
 *
 * A status with no tasks is absent rather than zero, and the caller defaults it: the distinction
 * between "none" and "not asked about" never matters here.
 */
export function countTasksByStatus(database: Database): Map<TaskStatus, number> {
  const counts = new Map<TaskStatus, number>()

  for (const raw of database
    .prepare('select status, count(*) as count from tasks group by status')
    .all()) {
    const row = raw as Row
    counts.set(String(row.status) as TaskStatus, Number(row.count))
  }

  return counts
}

/** What `GET /api/tasks` can ask for. Every field is optional and they combine with `and`. */
export interface TaskQuery {
  readonly status?: readonly TaskStatus[]
  /** A project id, or `null` for the tasks belonging to no project. Omit for either. */
  readonly projectId?: string | null
  readonly tag?: string
  /** Due at or before this moment. Tasks with no due date are excluded. */
  readonly dueBefore?: number
  /** Case-insensitive substring of the title or the notes. Treated as literal text. */
  readonly search?: string
  /** Include next actions still deferred. Off by default, per spec 01 criterion 5. */
  readonly includeDeferred?: boolean
  readonly limit?: number
  readonly offset?: number
}

export interface TaskPage {
  readonly tasks: Task[]
  /** Matching rows before `limit` and `offset`, so a client can page through them. */
  readonly total: number
}

/** `like` treats these as wildcards, so a search for `100%` has to escape them first. */
function likePattern(search: string): string {
  return `%${search.replace(/[\\%_]/g, (character) => `\\${character}`)}%`
}

/** What a bound parameter may be. Everything a filter binds is text or an integer. */
type Bindable = string | number

interface Filter {
  readonly sql: string
  readonly params: readonly Bindable[]
}

function filters(query: TaskQuery, now: number): Filter[] {
  const built: Filter[] = []

  if (query.status !== undefined) {
    // An empty status list matches nothing, which is what asking for no statuses means.
    const placeholders = query.status.map(() => '?').join(', ')
    built.push({ sql: `status in (${placeholders})`, params: query.status })
  }

  if (query.projectId !== undefined) {
    built.push(
      query.projectId === null
        ? { sql: 'project_id is null', params: [] }
        : { sql: 'project_id = ?', params: [query.projectId] },
    )
  }

  if (query.tag !== undefined) {
    // `exists` rather than a join: a task with two matching tags is still one task.
    built.push({
      sql: 'exists (select 1 from task_tags where task_tags.task_id = tasks.id and tag = ?)',
      params: [query.tag],
    })
  }

  if (query.dueBefore !== undefined) {
    built.push({ sql: 'due_at is not null and due_at <= ?', params: [query.dueBefore] })
  }

  if (query.search !== undefined) {
    // SQLite's `like` is already case-insensitive for ASCII, which is what `lower()` on
    // both sides would buy and no more.
    built.push({
      sql: "(title like ? escape '\\' or notes like ? escape '\\')",
      params: [likePattern(query.search), likePattern(query.search)],
    })
  }

  if (query.includeDeferred !== true) {
    // Deferral hides a next action and nothing else: a task waiting on someone is still
    // waiting whether or not you have deferred looking at it. Spec 01, criterion 5.
    built.push({
      sql: "not (status = 'next_action' and defer_until is not null and defer_until > ?)",
      params: [now],
    })
  }

  return built
}

/**
 * The filtered, ordered, paginated listing behind `GET /api/tasks`. `now` is passed rather
 * than read so that deferral is testable without waiting for a clock.
 */
export function listTasks(database: Database, query: TaskQuery, now: number): TaskPage {
  const built = filters(query, now)
  const where = built.length === 0 ? '' : `where ${built.map((filter) => filter.sql).join(' and ')}`
  const params: Bindable[] = built.flatMap((filter) => [...filter.params])

  const total = Number(
    (database.prepare(`select count(*) as count from tasks ${where}`).get(...params) as Row).count,
  )

  // A negative limit is SQLite's "no limit", and offset needs a limit present to be legal.
  const tasks = database
    .prepare(`select ${columns} from tasks ${where} ${ordering} limit ? offset ?`)
    .all(...params, query.limit ?? -1, query.offset ?? 0)
    .map((row) => toTask(row as Row))

  return { tasks, total }
}

/** Why a bulk operation skipped one of the tasks it was given. */
export type BulkRefusal = 'not-found' | StatusChangeRefusal

export type BulkResult =
  | { readonly id: string; readonly applied: true }
  | { readonly id: string; readonly applied: false; readonly reason: BulkRefusal }

/**
 * Bulk operations are all-or-nothing at the database level and per-task in their reporting:
 * one transaction, so a failed write leaves nothing half-applied, but a task that does not
 * exist or that the status rules refuse is reported rather than aborting the rest.
 */
export function bulkChangeStatus(
  database: Database,
  ids: readonly string[],
  change: StatusChange,
): BulkResult[] {
  return withTransaction(database, () =>
    ids.map((id) => {
      const result = changeTaskStatus(database, id, change)
      if (result === null) return { id, applied: false as const, reason: 'not-found' as const }
      return result.applied
        ? { id, applied: true as const }
        : { id, applied: false as const, reason: result.reason }
    }),
  )
}

export function bulkAssignProject(
  database: Database,
  ids: readonly string[],
  projectId: string | null,
  now: number,
): BulkResult[] {
  return withTransaction(database, () =>
    ids.map((id) =>
      updateTask(database, id, { projectId }, now) === null
        ? { id, applied: false as const, reason: 'not-found' as const }
        : { id, applied: true as const },
    ),
  )
}

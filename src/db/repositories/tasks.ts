import { randomUUID } from 'node:crypto'
import { withTransaction, type Database } from '../connection.js'
import { booleanToInteger, toTask, type Row } from '../rows.js'
import {
  applyStatusChange,
  enableSyncTracking,
  newTask,
  type NewTaskInput,
  type StatusChange,
  type StatusChangeRefusal,
  type StatusChangeResult,
  type Task,
  type TaskStatus,
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
  defer_until, waiting_on, status_set_by, status_set_at, sync_tracked, created_at, updated_at,
  completed_at`

/** Manual ordering first, then stable tiebreaks so a list never reshuffles between reads. */
const ordering = 'order by sort_order, created_at, id'

function writeTask(database: Database, task: Task): void {
  database
    .prepare(
      `insert into tasks (${columns}) values (
         :id, :title, :notes, :status, :project_id, :sort_order, :estimate_minutes, :due_at,
         :defer_until, :waiting_on, :status_set_by, :status_set_at, :sync_tracked, :created_at,
         :updated_at, :completed_at
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
         status_set_by = excluded.status_set_by,
         status_set_at = excluded.status_set_at,
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
      status_set_by: task.statusSetBy,
      status_set_at: task.statusSetAt,
      sync_tracked: booleanToInteger(task.syncTracked),
      created_at: task.createdAt,
      updated_at: task.updatedAt,
      completed_at: task.completedAt,
    })
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
  if (result.applied) writeTask(database, result.task)

  return result
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

/** Hard delete, only ever from an explicit user action. Sync never calls this. Spec 01. */
export function deleteTask(database: Database, id: string): boolean {
  return database.prepare('delete from tasks where id = ?').run(id).changes > 0
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

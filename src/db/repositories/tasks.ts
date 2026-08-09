import { randomUUID } from 'node:crypto'
import { withTransaction, type Database } from '../connection.js'
import { booleanToInteger, toTask, type Row } from '../rows.js'
import {
  applyStatusChange,
  enableSyncTracking,
  newTask,
  type NewTaskInput,
  type StatusChange,
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

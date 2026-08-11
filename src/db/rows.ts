/**
 * Mapping between SQLite rows and the domain types. Kept in one place so the column names
 * appear exactly twice: in the migration, and here.
 *
 * `node:sqlite` returns null-prototype objects whose values are typed as `unknown` to the
 * compiler, so every field is read through a converter rather than cast wholesale. That is
 * also where `sync_tracked` stops being the integer SQLite stores and becomes a boolean.
 */
import type { Project, ProjectState } from '../domain/project.js'
import type { StatusActor, Task, TaskStatus } from '../domain/task.js'

export type Row = Record<string, unknown>

function text(row: Row, column: string): string {
  const value = row[column]
  if (typeof value !== 'string') {
    throw new TypeError(`expected ${column} to be text, got ${typeof value}`)
  }
  return value
}

function nullableText(row: Row, column: string): string | null {
  const value = row[column]
  return value === null || value === undefined ? null : text(row, column)
}

function integer(row: Row, column: string): number {
  const value = row[column]
  if (typeof value === 'bigint') return Number(value)
  if (typeof value !== 'number') {
    throw new TypeError(`expected ${column} to be an integer, got ${typeof value}`)
  }
  return value
}

function nullableInteger(row: Row, column: string): number | null {
  const value = row[column]
  return value === null || value === undefined ? null : integer(row, column)
}

/** SQLite has no boolean type, so the column holds 0 or 1 and the domain holds a boolean. */
function boolean(row: Row, column: string): boolean {
  return integer(row, column) !== 0
}

export function booleanToInteger(value: boolean): number {
  return value ? 1 : 0
}

export function toTask(row: Row): Task {
  return {
    id: text(row, 'id'),
    title: text(row, 'title'),
    notes: nullableText(row, 'notes'),
    status: text(row, 'status') as TaskStatus,
    projectId: nullableText(row, 'project_id'),
    sortOrder: integer(row, 'sort_order'),
    estimateMinutes: nullableInteger(row, 'estimate_minutes'),
    dueAt: nullableInteger(row, 'due_at'),
    deferUntil: nullableInteger(row, 'defer_until'),
    waitingOn: nullableText(row, 'waiting_on'),
    statusSetBy: text(row, 'status_set_by') as StatusActor,
    statusSetAt: integer(row, 'status_set_at'),
    previousStatus: nullableText(row, 'previous_status') as TaskStatus | null,
    previousStatusSetBy: nullableText(row, 'previous_status_set_by') as StatusActor | null,
    syncTracked: boolean(row, 'sync_tracked'),
    createdAt: integer(row, 'created_at'),
    updatedAt: integer(row, 'updated_at'),
    completedAt: nullableInteger(row, 'completed_at'),
  }
}

export function toProject(row: Row): Project {
  return {
    id: text(row, 'id'),
    title: text(row, 'title'),
    notes: nullableText(row, 'notes'),
    state: text(row, 'state') as ProjectState,
    createdAt: integer(row, 'created_at'),
    updatedAt: integer(row, 'updated_at'),
    completedAt: nullableInteger(row, 'completed_at'),
  }
}

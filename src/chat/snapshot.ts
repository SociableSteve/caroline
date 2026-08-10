/**
 * Rows as they were, on their way into a stored inverse operation. Spec 07: undo is an inverse
 * decided at the moment of the change, because that is the last moment the previous values are
 * there to read.
 *
 * The snapshots are read back out of JSON later, so they are reconstructed field by field rather
 * than cast. It is Caroline's own JSON and should never be the wrong shape, but a cast would turn
 * "should never" into a restore that writes rubbish into a task row.
 */
import type { Database } from '../db/connection.js'
import { listPlanEntryIdsForTask } from '../db/repositories/daily-plans.js'
import { getProject } from '../db/repositories/projects.js'
import { listSourcesForTask } from '../db/repositories/sources.js'
import { getTask, getTaskTags } from '../db/repositories/tasks.js'
import type { ChatInverse } from '../domain/chat.js'
import { projectStates, type Project, type ProjectState } from '../domain/project.js'
import {
  statusActors,
  taskStatuses,
  type StatusActor,
  type Task,
  type TaskStatus,
} from '../domain/task.js'

/** A task as it stood, with the links a delete would clear. */
export interface TaskSnapshot {
  readonly task: Task
  readonly tags: readonly string[]
  /** Sources linked to it. A delete clears the link rather than the row (migration 1). */
  readonly sourceIds: readonly string[]
  /** Daily-plan entries naming it. A delete clears those links too (migration 5). */
  readonly planEntryIds: readonly string[]
}

export function snapshotTask(database: Database, id: string): TaskSnapshot | null {
  const task = getTask(database, id)
  if (task === null) return null

  return {
    task,
    tags: getTaskTags(database, id),
    sourceIds: listSourcesForTask(database, id).map((source) => source.id),
    planEntryIds: listPlanEntryIdsForTask(database, id),
  }
}

/**
 * The inverse that puts a task back exactly as it was, tags and source links included.
 * `withLinks` is false for an edit, where the links were never touched and reasserting them would
 * be a write nobody asked for.
 */
export function restoreTaskInverse(
  snapshot: TaskSnapshot,
  { withLinks = false }: { withLinks?: boolean } = {},
): ChatInverse {
  return {
    kind: 'restore-task',
    task: { ...snapshot.task },
    tags: [...snapshot.tags],
    ...(withLinks
      ? { sourceIds: [...snapshot.sourceIds], planEntryIds: [...snapshot.planEntryIds] }
      : {}),
  }
}

export function snapshotProject(database: Database, id: string): Project | null {
  return getProject(database, id)
}

export function restoreProjectInverse(project: Project): ChatInverse {
  return { kind: 'restore-project', project: { ...project } }
}

function text(row: Record<string, unknown>, key: string): string | null {
  const value = row[key]
  return typeof value === 'string' ? value : null
}

function nullableText(row: Record<string, unknown>, key: string): string | null | undefined {
  const value = row[key]
  if (value === null) return null
  return typeof value === 'string' ? value : undefined
}

function integer(row: Record<string, unknown>, key: string): number | null {
  const value = row[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function nullableInteger(row: Record<string, unknown>, key: string): number | null | undefined {
  const value = row[key]
  if (value === null) return null
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function oneOf<T extends string>(
  row: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | null {
  const value = row[key]
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null
}

/** A task read back from a stored snapshot, or null when the snapshot is not one. */
export function taskFromSnapshot(value: unknown): Task | null {
  if (value === null || typeof value !== 'object') return null
  const row = value as Record<string, unknown>

  const id = text(row, 'id')
  const title = text(row, 'title')
  const status = oneOf<TaskStatus>(row, 'status', taskStatuses)
  const statusSetBy = oneOf<StatusActor>(row, 'statusSetBy', statusActors)
  const statusSetAt = integer(row, 'statusSetAt')
  const sortOrder = integer(row, 'sortOrder')
  const createdAt = integer(row, 'createdAt')
  const updatedAt = integer(row, 'updatedAt')
  const notes = nullableText(row, 'notes')
  const projectId = nullableText(row, 'projectId')
  const waitingOn = nullableText(row, 'waitingOn')
  const estimateMinutes = nullableInteger(row, 'estimateMinutes')
  const dueAt = nullableInteger(row, 'dueAt')
  const deferUntil = nullableInteger(row, 'deferUntil')
  const completedAt = nullableInteger(row, 'completedAt')

  if (
    id === null ||
    title === null ||
    status === null ||
    statusSetBy === null ||
    statusSetAt === null ||
    sortOrder === null ||
    createdAt === null ||
    updatedAt === null ||
    notes === undefined ||
    projectId === undefined ||
    waitingOn === undefined ||
    estimateMinutes === undefined ||
    dueAt === undefined ||
    deferUntil === undefined ||
    completedAt === undefined ||
    typeof row.syncTracked !== 'boolean'
  ) {
    return null
  }

  return {
    id,
    title,
    notes,
    status,
    projectId,
    sortOrder,
    estimateMinutes,
    dueAt,
    deferUntil,
    waitingOn,
    statusSetBy,
    statusSetAt,
    syncTracked: row.syncTracked,
    createdAt,
    updatedAt,
    completedAt,
  }
}

/** A project read back from a stored snapshot, or null when the snapshot is not one. */
export function projectFromSnapshot(value: unknown): Project | null {
  if (value === null || typeof value !== 'object') return null
  const row = value as Record<string, unknown>

  const id = text(row, 'id')
  const title = text(row, 'title')
  const state = oneOf<ProjectState>(row, 'state', projectStates)
  const createdAt = integer(row, 'createdAt')
  const updatedAt = integer(row, 'updatedAt')
  const notes = nullableText(row, 'notes')
  const completedAt = nullableInteger(row, 'completedAt')

  if (
    id === null ||
    title === null ||
    state === null ||
    createdAt === null ||
    updatedAt === null ||
    notes === undefined ||
    completedAt === undefined
  ) {
    return null
  }

  return { id, title, notes, state, createdAt, updatedAt, completedAt }
}

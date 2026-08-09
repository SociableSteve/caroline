import { randomUUID } from 'node:crypto'
import type { Database } from '../connection.js'
import { toProject, type Row } from '../rows.js'
import {
  completeProject,
  deriveNextAction,
  isStalled,
  newProject,
  openTasks,
  type NewProjectInput,
  type Project,
  type ProjectState,
} from '../../domain/project.js'
import type { Task } from '../../domain/task.js'
import { listProjectTasks } from './tasks.js'

export interface CreateProjectInput extends Omit<NewProjectInput, 'id'> {
  readonly id?: string
}

export interface ProjectPatch {
  readonly title?: string
  readonly notes?: string | null
  readonly state?: ProjectState
}

const columns = 'id, title, notes, state, created_at, updated_at, completed_at'

function writeProject(database: Database, project: Project): void {
  database
    .prepare(
      `insert into projects (${columns}) values (
         :id, :title, :notes, :state, :created_at, :updated_at, :completed_at
       )
       on conflict (id) do update set
         title = excluded.title,
         notes = excluded.notes,
         state = excluded.state,
         updated_at = excluded.updated_at,
         completed_at = excluded.completed_at`,
    )
    .run({
      id: project.id,
      title: project.title,
      notes: project.notes,
      state: project.state,
      created_at: project.createdAt,
      updated_at: project.updatedAt,
      completed_at: project.completedAt,
    })
}

export function createProject(database: Database, input: CreateProjectInput, now: number): Project {
  const project = newProject({ ...input, id: input.id ?? randomUUID() }, now)
  writeProject(database, project)
  return project
}

export function getProject(database: Database, id: string): Project | null {
  const row = database.prepare(`select ${columns} from projects where id = ?`).get(id)
  return row === undefined ? null : toProject(row as Row)
}

export function listProjects(database: Database, state?: ProjectState): Project[] {
  const rows =
    state === undefined
      ? database.prepare(`select ${columns} from projects order by created_at, id`).all()
      : database
          .prepare(`select ${columns} from projects where state = ? order by created_at, id`)
          .all(state)

  return rows.map((row) => toProject(row as Row))
}

export function updateProject(
  database: Database,
  id: string,
  patch: ProjectPatch,
  now: number,
): Project | null {
  const existing = getProject(database, id)
  if (existing === null) return null

  const updated: Project = { ...existing, ...patch, updatedAt: now }
  writeProject(database, updated)

  return updated
}

/**
 * Completing a project does not complete its tasks. The open ones come back with it so the
 * caller can flag them. Spec 01, completion.
 */
export function markProjectComplete(
  database: Database,
  id: string,
  now: number,
): { project: Project; openTasks: readonly Task[] } | null {
  const existing = getProject(database, id)
  if (existing === null) return null

  const project = completeProject(existing, now)
  writeProject(database, project)

  return { project, openTasks: openTasks(listProjectTasks(database, id)) }
}

/** The project's next action, derived from its tasks rather than stored. Criterion 4. */
export function getProjectNextAction(database: Database, id: string): Task | null {
  return deriveNextAction(listProjectTasks(database, id))
}

/** Active projects with nothing to do next. What a weekly review is actually looking for. */
export function listStalledProjects(database: Database): Project[] {
  return listProjects(database, 'active').filter((project) =>
    isStalled(project, listProjectTasks(database, project.id)),
  )
}

/**
 * Deleting a project orphans its tasks rather than taking them with it: the work did not
 * stop being real because the outcome was abandoned. The `on delete set null` foreign key
 * in migration 1 does the orphaning. Spec 01, criterion 6.
 */
export function deleteProject(database: Database, id: string): boolean {
  return database.prepare('delete from projects where id = ?').run(id).changes > 0
}

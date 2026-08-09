import { beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '../../../src/db/connection.js'
import {
  createProject,
  deleteProject,
  getProject,
  getProjectNextAction,
  listProjects,
  listStalledProjects,
  markProjectComplete,
  updateProject,
} from '../../../src/db/repositories/projects.js'
import { createTask, getTask, listProjectTasks } from '../../../src/db/repositories/tasks.js'
import { migratedDatabase } from '../../helpers/temp-database.js'

const createdAt = Date.UTC(2026, 0, 1)
const later = createdAt + 60_000

let database: Database

beforeEach(() => {
  database = migratedDatabase()
})

describe('createProject', () => {
  it('starts a project active and reads back what it wrote', () => {
    const project = createProject(database, { title: 'Conference talk delivered' }, createdAt)

    expect(project.state).toBe('active')
    expect(getProject(database, project.id)).toEqual(project)
  })

  it('generates an id when the caller does not supply one', () => {
    const project = createProject(database, { title: 'Ship Caroline' }, createdAt)

    expect(project.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('reports null for a project that does not exist', () => {
    expect(getProject(database, 'nonexistent')).toBeNull()
  })
})

describe('listProjects', () => {
  it('filters by state when asked', () => {
    createProject(database, { id: 'project-1', title: 'Active work' }, createdAt)
    createProject(database, { id: 'project-2', title: 'Later', state: 'someday' }, createdAt)

    expect(listProjects(database, 'someday').map((project) => project.id)).toEqual(['project-2'])
  })

  it('returns every project when no state is given', () => {
    createProject(database, { id: 'project-1', title: 'Active work' }, createdAt)
    createProject(database, { id: 'project-2', title: 'Later', state: 'someday' }, createdAt)

    expect(listProjects(database)).toHaveLength(2)
  })
})

describe('getProjectNextAction', () => {
  // Criterion 4, first half.
  it('reports the one next_action task as the next action', () => {
    const project = createProject(database, { title: 'Conference talk' }, createdAt)
    createTask(
      database,
      { title: 'Book travel', status: 'waiting', projectId: project.id },
      createdAt,
    )
    const nextAction = createTask(
      database,
      { title: 'Draft the abstract', status: 'next_action', projectId: project.id },
      createdAt,
    )

    expect(getProjectNextAction(database, project.id)?.id).toBe(nextAction.id)
  })

  it('picks the earliest sort_order when several qualify', () => {
    const project = createProject(database, { title: 'Conference talk' }, createdAt)
    createTask(
      database,
      {
        id: 'task-late',
        title: 'Rehearse',
        status: 'next_action',
        projectId: project.id,
        sortOrder: 30,
      },
      createdAt,
    )
    createTask(
      database,
      {
        id: 'task-early',
        title: 'Draft slides',
        status: 'next_action',
        projectId: project.id,
        sortOrder: 10,
      },
      createdAt,
    )

    expect(getProjectNextAction(database, project.id)?.id).toBe('task-early')
  })

  it('ignores next actions belonging to a different project', () => {
    const project = createProject(database, { id: 'project-1', title: 'Talk' }, createdAt)
    const other = createProject(database, { id: 'project-2', title: 'Book' }, createdAt)
    createTask(
      database,
      { title: 'Draft slides', status: 'next_action', projectId: other.id },
      createdAt,
    )

    expect(getProjectNextAction(database, project.id)).toBeNull()
  })

  it('ignores loose tasks that belong to no project', () => {
    const project = createProject(database, { title: 'Talk' }, createdAt)
    createTask(database, { title: 'Buy milk', status: 'next_action' }, createdAt)

    expect(getProjectNextAction(database, project.id)).toBeNull()
  })
})

describe('listStalledProjects', () => {
  // Criterion 4, second half.
  it('reports an active project with no next action', () => {
    const project = createProject(database, { title: 'Conference talk' }, createdAt)
    createTask(
      database,
      { title: 'Book travel', status: 'waiting', projectId: project.id },
      createdAt,
    )

    expect(listStalledProjects(database).map((found) => found.id)).toEqual([project.id])
  })

  it('reports an active project with no tasks at all', () => {
    const project = createProject(database, { title: 'Conference talk' }, createdAt)

    expect(listStalledProjects(database).map((found) => found.id)).toEqual([project.id])
  })

  it('does not report a project that has a next action', () => {
    const project = createProject(database, { title: 'Conference talk' }, createdAt)
    createTask(
      database,
      { title: 'Draft slides', status: 'next_action', projectId: project.id },
      createdAt,
    )

    expect(listStalledProjects(database)).toEqual([])
  })

  it('does not report a someday project, which is not meant to be moving', () => {
    createProject(database, { title: 'Learn Welsh', state: 'someday' }, createdAt)

    expect(listStalledProjects(database)).toEqual([])
  })
})

describe('markProjectComplete', () => {
  it('marks the project done', () => {
    const project = createProject(database, { title: 'Conference talk' }, createdAt)

    const result = markProjectComplete(database, project.id, later)

    expect(result?.project.state).toBe('done')
    expect(result?.project.completedAt).toBe(later)
  })

  it('leaves open tasks open and hands them back to be flagged', () => {
    const project = createProject(database, { title: 'Conference talk' }, createdAt)
    const open = createTask(
      database,
      { title: 'Book travel', status: 'waiting', projectId: project.id },
      createdAt,
    )
    createTask(
      database,
      { title: 'Draft slides', status: 'done', projectId: project.id },
      createdAt,
    )

    const result = markProjectComplete(database, project.id, later)

    expect(result?.openTasks.map((task) => task.id)).toEqual([open.id])
    expect(getTask(database, open.id)?.status).toBe('waiting')
  })

  it('reports null for a project that does not exist', () => {
    expect(markProjectComplete(database, 'nonexistent', later)).toBeNull()
  })
})

describe('updateProject', () => {
  it('changes only the fields it was given', () => {
    const project = createProject(
      database,
      { title: 'Conference talk', notes: 'Original notes' },
      createdAt,
    )

    const updated = updateProject(database, project.id, { state: 'someday' }, later)

    expect(updated?.state).toBe('someday')
    expect(updated?.notes).toBe('Original notes')
  })

  it('reports null for a project that does not exist', () => {
    expect(updateProject(database, 'nonexistent', { title: 'Nothing' }, later)).toBeNull()
  })
})

describe('deleteProject', () => {
  // Criterion 6. The work did not stop being real because the outcome was abandoned.
  it('orphans its tasks rather than deleting them', () => {
    const project = createProject(database, { title: 'Conference talk' }, createdAt)
    const task = createTask(
      database,
      { title: 'Draft slides', status: 'next_action', projectId: project.id },
      createdAt,
    )

    deleteProject(database, project.id)

    expect(getTask(database, task.id)?.projectId).toBeNull()
  })

  it('keeps the orphaned task in its own status', () => {
    const project = createProject(database, { title: 'Conference talk' }, createdAt)
    const task = createTask(
      database,
      { title: 'Draft slides', status: 'next_action', projectId: project.id },
      createdAt,
    )

    deleteProject(database, project.id)

    expect(getTask(database, task.id)?.status).toBe('next_action')
  })

  it('removes the project itself', () => {
    const project = createProject(database, { title: 'Conference talk' }, createdAt)

    expect(deleteProject(database, project.id)).toBe(true)
    expect(getProject(database, project.id)).toBeNull()
  })

  it('leaves tasks belonging to other projects alone', () => {
    const doomed = createProject(database, { id: 'project-1', title: 'Talk' }, createdAt)
    const survivor = createProject(database, { id: 'project-2', title: 'Book' }, createdAt)
    const task = createTask(
      database,
      { title: 'Write chapter one', projectId: survivor.id },
      createdAt,
    )

    deleteProject(database, doomed.id)

    expect(getTask(database, task.id)?.projectId).toBe(survivor.id)
    expect(listProjectTasks(database, survivor.id)).toHaveLength(1)
  })

  it('reports false for a project that was not there', () => {
    expect(deleteProject(database, 'nonexistent')).toBe(false)
  })
})

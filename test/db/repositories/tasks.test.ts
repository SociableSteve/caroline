import { beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '../../../src/db/connection.js'
import { createProject } from '../../../src/db/repositories/projects.js'
import {
  changeTaskStatus,
  createTask,
  deleteTask,
  getTask,
  getTaskTags,
  listNextActions,
  listTasksByStatus,
  setSyncTracking,
  setTaskTags,
  undoTaskStatus,
  updateTask,
} from '../../../src/db/repositories/tasks.js'
import { githubTrackedStatuses } from '../../../src/domain/task.js'
import { migratedDatabase } from '../../helpers/temp-database.js'

const createdAt = Date.UTC(2026, 0, 1)
const later = createdAt + 60_000

let database: Database

beforeEach(() => {
  database = migratedDatabase()
})

/**
 * The previous status pair, through the database rather than in memory. Spec 01, criteria 8 to 11.
 */
describe('undoTaskStatus', () => {
  const undoneAt = later + 60_000

  it('restores the status and the actor, and persists both', () => {
    const task = createTask(
      database,
      { title: 'Sort the inbox item', status: 'inbox', statusSetBy: 'llm' },
      createdAt,
    )
    changeTaskStatus(database, task.id, { status: 'someday', by: 'user', at: later })

    const result = undoTaskStatus(database, task.id, undoneAt)

    expect(result?.undone).toBe(true)
    expect(getTask(database, task.id)).toMatchObject({
      status: 'inbox',
      statusSetBy: 'llm',
      previousStatus: null,
      previousStatusSetBy: null,
    })
  })

  it('reports nothing to put back on a task never changed, and leaves it alone', () => {
    const task = createTask(database, { title: 'Book the venue' }, createdAt)

    const result = undoTaskStatus(database, task.id, undoneAt)

    expect(result).toEqual({ undone: false, task })
    expect(getTask(database, task.id)).toEqual(task)
  })

  it('answers null for a task that is not there, so a caller can tell it from a refusal', () => {
    expect(undoTaskStatus(database, 'no-such-task', undoneAt)).toBeNull()
  })
})

describe('createTask', () => {
  // Criterion 1, now through the database rather than in memory.
  it('defaults status to inbox, set by the user', () => {
    const task = createTask(database, { title: 'Book the venue' }, createdAt)

    expect(task.status).toBe('inbox')
    expect(task.statusSetBy).toBe('user')
    expect(task.statusSetAt).toBe(createdAt)
  })

  it('reads back exactly what it wrote', () => {
    const task = createTask(database, { title: 'Book the venue' }, createdAt)

    expect(getTask(database, task.id)).toEqual(task)
  })

  it('generates an id when the caller does not supply one', () => {
    const first = createTask(database, { title: 'Book the venue' }, createdAt)
    const second = createTask(database, { title: 'Book the caterer' }, createdAt)

    expect(first.id).not.toBe(second.id)
    expect(first.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('round-trips every nullable field', () => {
    const task = createTask(
      database,
      {
        title: 'Chase the invoice',
        notes: '# Context\n\nSent 3 January.',
        status: 'waiting',
        estimateMinutes: 15,
        dueAt: later,
        deferUntil: later,
        waitingOn: 'Accounts payable',
        sortOrder: 7,
      },
      createdAt,
    )

    expect(getTask(database, task.id)).toEqual(task)
  })

  it('round-trips sync_tracked as a boolean, not the integer SQLite stores', () => {
    const task = createTask(
      database,
      { title: 'Review PR 42', status: 'review', statusSetBy: 'sync' },
      createdAt,
    )

    expect(task.syncTracked).toBe(true)
    expect(getTask(database, task.id)?.syncTracked).toBe(true)
  })

  it('attaches the task to a project', () => {
    const project = createProject(database, { title: 'Conference talk' }, createdAt)
    const task = createTask(
      database,
      { title: 'Draft the abstract', projectId: project.id },
      createdAt,
    )

    expect(getTask(database, task.id)?.projectId).toBe(project.id)
  })
})

describe('getTask', () => {
  it('reports null for an id that does not exist', () => {
    expect(getTask(database, 'nonexistent')).toBeNull()
  })
})

describe('listNextActions', () => {
  // Criterion 5.
  it('excludes a task deferred into the future', () => {
    createTask(
      database,
      { title: 'Renew the domain', status: 'next_action', deferUntil: later },
      createdAt,
    )

    expect(listNextActions(database, createdAt)).toEqual([])
  })

  it('includes the same task once the deferral passes', () => {
    const task = createTask(
      database,
      { title: 'Renew the domain', status: 'next_action', deferUntil: later },
      createdAt,
    )

    expect(listNextActions(database, later).map((found) => found.id)).toEqual([task.id])
  })

  it('includes tasks with no deferral at all', () => {
    const task = createTask(database, { title: 'Draft slides', status: 'next_action' }, createdAt)

    expect(listNextActions(database, createdAt).map((found) => found.id)).toEqual([task.id])
  })

  it('excludes tasks in any other status', () => {
    createTask(database, { title: 'Book travel', status: 'waiting' }, createdAt)
    createTask(database, { title: 'Old notes', status: 'reference' }, createdAt)

    expect(listNextActions(database, createdAt)).toEqual([])
  })

  it('orders by sort_order, so the manual ordering survives the round trip', () => {
    createTask(
      database,
      { id: 'task-late', title: 'Rehearse', status: 'next_action', sortOrder: 30 },
      createdAt,
    )
    createTask(
      database,
      { id: 'task-early', title: 'Draft slides', status: 'next_action', sortOrder: 10 },
      createdAt,
    )

    expect(listNextActions(database, createdAt).map((task) => task.id)).toEqual([
      'task-early',
      'task-late',
    ])
  })
})

describe('listTasksByStatus', () => {
  it('returns only the requested status', () => {
    createTask(database, { id: 'task-1', title: 'Book travel', status: 'waiting' }, createdAt)
    createTask(database, { id: 'task-2', title: 'Draft slides', status: 'next_action' }, createdAt)

    expect(listTasksByStatus(database, 'waiting').map((task) => task.id)).toEqual(['task-1'])
  })

  // Deferral hides a task from Next actions specifically, not from its own status column.
  it('still returns a deferred task under its own status', () => {
    createTask(
      database,
      { id: 'task-1', title: 'Renew the domain', status: 'someday', deferUntil: later },
      createdAt,
    )

    expect(listTasksByStatus(database, 'someday').map((task) => task.id)).toEqual(['task-1'])
  })
})

describe('changeTaskStatus', () => {
  it('persists an applied change', () => {
    const task = createTask(database, { title: 'Book the venue' }, createdAt)

    const result = changeTaskStatus(database, task.id, {
      status: 'next_action',
      by: 'user',
      at: later,
    })

    expect(result?.applied).toBe(true)
    expect(getTask(database, task.id)?.status).toBe('next_action')
  })

  it('stamps completedAt when a task is completed', () => {
    const task = createTask(database, { title: 'Book the venue' }, createdAt)

    changeTaskStatus(database, task.id, { status: 'done', by: 'user', at: later })

    expect(getTask(database, task.id)?.completedAt).toBe(later)
  })

  // Criterion 2, the persistence half: a refused proposal writes nothing.
  it('leaves a user-set task untouched when the classifier proposes a change', () => {
    const task = createTask(database, { title: 'Book the venue' }, createdAt)

    const result = changeTaskStatus(database, task.id, {
      status: 'reference',
      by: 'llm',
      at: later,
    })

    expect(result).toMatchObject({ applied: false, reason: 'user-set' })
    expect(getTask(database, task.id)).toEqual(task)
  })

  // Criterion 2a.
  it('keeps a tracked task tracked when the user moves it inside the tracked set', () => {
    const task = createTask(
      database,
      { title: 'Review PR 42', status: 'review', statusSetBy: 'sync' },
      createdAt,
    )

    changeTaskStatus(database, task.id, {
      status: 'waiting',
      by: 'user',
      at: later,
      trackedStatuses: githubTrackedStatuses,
    })

    expect(getTask(database, task.id)?.syncTracked).toBe(true)
  })

  it('stops tracking when the user files the task outside the tracked set', () => {
    const task = createTask(
      database,
      { title: 'Review PR 42', status: 'review', statusSetBy: 'sync' },
      createdAt,
    )

    changeTaskStatus(database, task.id, {
      status: 'someday',
      by: 'user',
      at: later,
      trackedStatuses: githubTrackedStatuses,
    })

    expect(getTask(database, task.id)?.syncTracked).toBe(false)
  })

  it('ignores a later sync change once the user has opted out', () => {
    const task = createTask(
      database,
      { title: 'Review PR 42', status: 'review', statusSetBy: 'sync' },
      createdAt,
    )
    changeTaskStatus(database, task.id, {
      status: 'someday',
      by: 'user',
      at: later,
      trackedStatuses: githubTrackedStatuses,
    })

    const result = changeTaskStatus(database, task.id, {
      status: 'review',
      by: 'sync',
      at: later + 1,
      trackedStatuses: githubTrackedStatuses,
    })

    expect(result?.applied).toBe(false)
    expect(getTask(database, task.id)?.status).toBe('someday')
  })

  it('reports null for a task that does not exist', () => {
    expect(
      changeTaskStatus(database, 'nonexistent', { status: 'done', by: 'user', at: later }),
    ).toBeNull()
  })
})

describe('setSyncTracking', () => {
  it('re-enables tracking the user previously opted out of', () => {
    const task = createTask(
      database,
      { title: 'Review PR 42', status: 'review', statusSetBy: 'sync' },
      createdAt,
    )
    changeTaskStatus(database, task.id, {
      status: 'someday',
      by: 'user',
      at: later,
      trackedStatuses: githubTrackedStatuses,
    })

    setSyncTracking(database, task.id, true, later + 1)

    expect(getTask(database, task.id)?.syncTracked).toBe(true)
  })

  it('lets sync move the task again once tracking is back on', () => {
    const task = createTask(
      database,
      { title: 'Review PR 42', status: 'review', statusSetBy: 'sync' },
      createdAt,
    )
    changeTaskStatus(database, task.id, {
      status: 'someday',
      by: 'user',
      at: later,
      trackedStatuses: githubTrackedStatuses,
    })
    setSyncTracking(database, task.id, true, later + 1)

    const result = changeTaskStatus(database, task.id, {
      status: 'review',
      by: 'sync',
      at: later + 2,
      trackedStatuses: githubTrackedStatuses,
    })

    expect(result?.applied).toBe(true)
    expect(getTask(database, task.id)?.status).toBe('review')
  })
})

describe('updateTask', () => {
  it('changes only the fields it was given', () => {
    const task = createTask(
      database,
      { title: 'Book the venue', notes: 'Original notes' },
      createdAt,
    )

    const updated = updateTask(database, task.id, { title: 'Book the larger venue' }, later)

    expect(updated?.title).toBe('Book the larger venue')
    expect(updated?.notes).toBe('Original notes')
    expect(updated?.updatedAt).toBe(later)
  })

  it('clears a nullable field when explicitly given null', () => {
    const task = createTask(database, { title: 'Renew the domain', deferUntil: later }, createdAt)

    expect(updateTask(database, task.id, { deferUntil: null }, later)?.deferUntil).toBeNull()
  })

  it('does not change status, which goes through changeTaskStatus and its rules', () => {
    const task = createTask(database, { title: 'Book the venue' }, createdAt)

    updateTask(database, task.id, { title: 'Book the larger venue' }, later)

    expect(getTask(database, task.id)?.statusSetAt).toBe(createdAt)
  })

  it('reports null for a task that does not exist', () => {
    expect(updateTask(database, 'nonexistent', { title: 'Nothing' }, later)).toBeNull()
  })
})

describe('deleteTask', () => {
  it('removes the task', () => {
    const task = createTask(database, { title: 'Book the venue' }, createdAt)

    expect(deleteTask(database, task.id)).toBe(true)
    expect(getTask(database, task.id)).toBeNull()
  })

  it('reports false for a task that was not there', () => {
    expect(deleteTask(database, 'nonexistent')).toBe(false)
  })

  it('takes the task tags with it', () => {
    const task = createTask(database, { title: 'Book the venue' }, createdAt)
    setTaskTags(database, task.id, ['venue'])

    deleteTask(database, task.id)

    expect(database.prepare('select count(*) as count from task_tags').get()).toMatchObject({
      count: 0,
    })
  })
})

describe('task tags', () => {
  it('stores tags as rows rather than a delimited string', () => {
    const task = createTask(database, { title: 'Book the venue' }, createdAt)

    setTaskTags(database, task.id, ['venue', 'conference'])

    expect(getTaskTags(database, task.id)).toEqual(['conference', 'venue'])
  })

  it('replaces the whole set rather than appending to it', () => {
    const task = createTask(database, { title: 'Book the venue' }, createdAt)
    setTaskTags(database, task.id, ['venue', 'conference'])

    setTaskTags(database, task.id, ['venue'])

    expect(getTaskTags(database, task.id)).toEqual(['venue'])
  })

  it('ignores a repeated tag rather than failing on the primary key', () => {
    const task = createTask(database, { title: 'Book the venue' }, createdAt)

    setTaskTags(database, task.id, ['venue', 'venue'])

    expect(getTaskTags(database, task.id)).toEqual(['venue'])
  })

  it('reports no tags for a task that has none', () => {
    const task = createTask(database, { title: 'Book the venue' }, createdAt)

    expect(getTaskTags(database, task.id)).toEqual([])
  })
})

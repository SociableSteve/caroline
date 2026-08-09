import { describe, expect, it } from 'vitest'
import {
  applyStatusChange,
  githubTrackedStatuses,
  isDeferred,
  newTask,
  taskStatuses,
  type Task,
} from '../../src/domain/task.js'

const createdAt = Date.UTC(2026, 0, 1)

/** A saved task, with the fields under test overridable per case. */
function existingTask(overrides: Partial<Task> = {}): Task {
  return {
    ...newTask({ id: 'task-1', title: 'Review the deployment runbook' }, createdAt),
    ...overrides,
  }
}

describe('the seven statuses', () => {
  it('are exactly the ones spec 01 names, and project is not among them', () => {
    expect([...taskStatuses]).toEqual([
      'inbox',
      'next_action',
      'review',
      'waiting',
      'someday',
      'reference',
      'done',
    ])
    expect(taskStatuses).not.toContain('project')
  })
})

describe('newTask', () => {
  // Criterion 1.
  it('defaults a task with no status to inbox, set by the user', () => {
    const task = newTask({ id: 'task-1', title: 'Book the venue' }, createdAt)

    expect(task.status).toBe('inbox')
    expect(task.statusSetBy).toBe('user')
    expect(task.statusSetAt).toBe(createdAt)
  })

  it('honours an explicit status and the actor that chose it', () => {
    const task = newTask(
      { id: 'task-1', title: 'Review PR 42', status: 'review', statusSetBy: 'sync' },
      createdAt,
    )

    expect(task.status).toBe('review')
    expect(task.statusSetBy).toBe('sync')
  })

  it('leaves a manually captured task untracked by sync', () => {
    expect(newTask({ id: 'task-1', title: 'Book the venue' }, createdAt).syncTracked).toBe(false)
  })

  it('starts a sync-created task tracked', () => {
    const task = newTask(
      { id: 'task-1', title: 'Review PR 42', status: 'review', statusSetBy: 'sync' },
      createdAt,
    )

    expect(task.syncTracked).toBe(true)
  })

  it('leaves a new task uncompleted', () => {
    expect(newTask({ id: 'task-1', title: 'Book the venue' }, createdAt).completedAt).toBeNull()
  })
})

describe('applyStatusChange by the user', () => {
  const changedAt = createdAt + 60_000

  it('records the new status, the actor and the time', () => {
    const result = applyStatusChange(existingTask(), {
      status: 'next_action',
      by: 'user',
      at: changedAt,
    })

    expect(result.applied).toBe(true)
    expect(result.task.status).toBe('next_action')
    expect(result.task.statusSetBy).toBe('user')
    expect(result.task.statusSetAt).toBe(changedAt)
  })

  it('moves between any two statuses, because triage has no workflow graph', () => {
    const result = applyStatusChange(existingTask({ status: 'done' }), {
      status: 'waiting',
      by: 'user',
      at: changedAt,
    })

    expect(result.applied).toBe(true)
    expect(result.task.status).toBe('waiting')
  })

  it('stamps completedAt when the task becomes done', () => {
    const result = applyStatusChange(existingTask(), {
      status: 'done',
      by: 'user',
      at: changedAt,
    })

    expect(result.task.completedAt).toBe(changedAt)
  })

  it('clears completedAt when the task leaves done', () => {
    const done = existingTask({ status: 'done', completedAt: changedAt })
    const result = applyStatusChange(done, { status: 'next_action', by: 'user', at: changedAt })

    expect(result.task.completedAt).toBeNull()
  })

  it('does not mutate the task it was given', () => {
    const task = existingTask()
    applyStatusChange(task, { status: 'done', by: 'user', at: changedAt })

    expect(task.status).toBe('inbox')
    expect(task.completedAt).toBeNull()
  })
})

describe('applyStatusChange by the classifier', () => {
  const changedAt = createdAt + 60_000

  // Criterion 2, the half that is a domain rule. Recording the rejected proposal in
  // `classifications` belongs to spec 04 and lands with the classifier in M5.
  it('refuses to touch a task whose status the user set', () => {
    const task = existingTask({ status: 'inbox', statusSetBy: 'user', statusSetAt: createdAt })
    const result = applyStatusChange(task, { status: 'reference', by: 'llm', at: changedAt })

    expect(result).toMatchObject({ applied: false, reason: 'user-set' })
  })

  it('leaves the status fields of a user-set task exactly as they were', () => {
    const task = existingTask({ status: 'inbox', statusSetBy: 'user', statusSetAt: createdAt })
    const result = applyStatusChange(task, { status: 'reference', by: 'llm', at: changedAt })

    expect(result.task).toEqual(task)
  })

  it('applies to a task the user has never touched', () => {
    const task = existingTask({ status: 'inbox', statusSetBy: 'llm', statusSetAt: createdAt })
    const result = applyStatusChange(task, { status: 'reference', by: 'llm', at: changedAt })

    expect(result.applied).toBe(true)
    expect(result.task.status).toBe('reference')
    expect(result.task.statusSetBy).toBe('llm')
  })
})

describe('sync tracking', () => {
  const changedAt = createdAt + 60_000

  function trackedReviewTask(): Task {
    return existingTask({ status: 'review', statusSetBy: 'sync', syncTracked: true })
  }

  // Criterion 2a, first half.
  it('keeps tracking when the user moves the task inside the tracked set', () => {
    const result = applyStatusChange(trackedReviewTask(), {
      status: 'waiting',
      by: 'user',
      at: changedAt,
      trackedStatuses: githubTrackedStatuses,
    })

    expect(result.applied).toBe(true)
    expect(result.task.status).toBe('waiting')
    expect(result.task.syncTracked).toBe(true)
  })

  // Criterion 2a, second half. Filing a review request under someday is an opt-out.
  it('stops tracking when the user moves the task outside the tracked set', () => {
    const result = applyStatusChange(trackedReviewTask(), {
      status: 'someday',
      by: 'user',
      at: changedAt,
      trackedStatuses: githubTrackedStatuses,
    })

    expect(result.applied).toBe(true)
    expect(result.task.syncTracked).toBe(false)
  })

  it('ignores a later sync change once the user has opted out', () => {
    const optedOut = existingTask({ status: 'someday', statusSetBy: 'user', syncTracked: false })
    const result = applyStatusChange(optedOut, {
      status: 'review',
      by: 'sync',
      at: changedAt,
      trackedStatuses: githubTrackedStatuses,
    })

    expect(result).toMatchObject({ applied: false, reason: 'not-tracked' })
    expect(result.task.status).toBe('someday')
  })

  it('lets sync move a tracked task backwards through the lifecycle', () => {
    const reviewed = existingTask({ status: 'waiting', statusSetBy: 'sync', syncTracked: true })
    const result = applyStatusChange(reviewed, {
      status: 'review',
      by: 'sync',
      at: changedAt,
      trackedStatuses: githubTrackedStatuses,
    })

    expect(result.applied).toBe(true)
    expect(result.task.status).toBe('review')
    expect(result.task.syncTracked).toBe(true)
  })

  it('never re-enables tracking by itself: only an explicit re-enable does that', () => {
    const optedOut = existingTask({ status: 'someday', syncTracked: false })
    const result = applyStatusChange(optedOut, {
      status: 'review',
      by: 'user',
      at: changedAt,
      trackedStatuses: githubTrackedStatuses,
    })

    expect(result.task.syncTracked).toBe(false)
  })

  it('declares review, waiting and done as the GitHub connector tracked set', () => {
    expect([...githubTrackedStatuses]).toEqual(['review', 'waiting', 'done'])
  })
})

describe('isDeferred', () => {
  const now = Date.UTC(2026, 0, 10)

  // Criterion 5. The repository query and the daily planner both build on this.
  it('defers a task whose deferUntil is still in the future', () => {
    expect(isDeferred(existingTask({ deferUntil: now + 1 }), now)).toBe(true)
  })

  it('releases a task the moment deferUntil passes', () => {
    expect(isDeferred(existingTask({ deferUntil: now }), now)).toBe(false)
  })

  it('never defers a task with no deferUntil', () => {
    expect(isDeferred(existingTask({ deferUntil: null }), now)).toBe(false)
  })
})

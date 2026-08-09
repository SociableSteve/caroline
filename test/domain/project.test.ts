import { describe, expect, it } from 'vitest'
import {
  completeProject,
  deriveNextAction,
  isStalled,
  newProject,
  openTasks,
  projectStates,
  type Project,
} from '../../src/domain/project.js'
import { newTask, type NewTaskInput, type Task } from '../../src/domain/task.js'

const createdAt = Date.UTC(2026, 0, 1)

function projectTask(input: NewTaskInput): Task {
  return newTask({ projectId: 'project-1', ...input }, createdAt)
}

function activeProject(overrides: Partial<Project> = {}): Project {
  return {
    ...newProject({ id: 'project-1', title: 'Conference talk accepted and delivered' }, createdAt),
    ...overrides,
  }
}

describe('the project states', () => {
  it('are exactly the ones spec 01 names', () => {
    expect([...projectStates]).toEqual(['active', 'someday', 'done', 'dropped'])
  })
})

describe('newProject', () => {
  it('starts a project active and uncompleted', () => {
    const project = newProject({ id: 'project-1', title: 'Ship Caroline' }, createdAt)

    expect(project.state).toBe('active')
    expect(project.completedAt).toBeNull()
  })
})

describe('deriveNextAction', () => {
  // Criterion 4, first half.
  it('reports the only next_action task as the next action', () => {
    const nextAction = projectTask({ id: 'task-1', title: 'Draft the abstract', status: 'inbox' })
    const tasks = [
      projectTask({ id: 'task-2', title: 'Book travel', status: 'waiting' }),
      { ...nextAction, status: 'next_action' as const },
    ]

    expect(deriveNextAction(tasks)?.id).toBe('task-1')
  })

  it('picks the earliest sort_order when several tasks qualify', () => {
    const tasks = [
      projectTask({ id: 'task-late', title: 'Rehearse', status: 'next_action', sortOrder: 30 }),
      projectTask({
        id: 'task-early',
        title: 'Draft slides',
        status: 'next_action',
        sortOrder: 10,
      }),
      projectTask({ id: 'task-mid', title: 'Book travel', status: 'next_action', sortOrder: 20 }),
    ]

    expect(deriveNextAction(tasks)?.id).toBe('task-early')
  })

  it('breaks a sort_order tie by creation time, so the answer is stable', () => {
    const tasks = [
      {
        ...projectTask({ id: 'task-newer', title: 'Rehearse', status: 'next_action' }),
        createdAt: createdAt + 5,
      },
      {
        ...projectTask({ id: 'task-older', title: 'Draft slides', status: 'next_action' }),
        createdAt,
      },
    ]

    expect(deriveNextAction(tasks)?.id).toBe('task-older')
  })

  it('reports no next action when nothing qualifies', () => {
    const tasks = [
      projectTask({ id: 'task-1', title: 'Book travel', status: 'waiting' }),
      projectTask({ id: 'task-2', title: 'Old notes', status: 'reference' }),
    ]

    expect(deriveNextAction(tasks)).toBeNull()
  })

  it('reports no next action for a project with no tasks at all', () => {
    expect(deriveNextAction([])).toBeNull()
  })
})

describe('isStalled', () => {
  const waitingTask = projectTask({ id: 'task-1', title: 'Book travel', status: 'waiting' })

  // Criterion 4, second half.
  it('stalls an active project with no next action', () => {
    expect(isStalled(activeProject(), [waitingTask])).toBe(true)
  })

  it('stalls an active project with no tasks at all', () => {
    expect(isStalled(activeProject(), [])).toBe(true)
  })

  it('does not stall an active project that has a next action', () => {
    const nextAction = projectTask({ id: 'task-2', title: 'Draft slides', status: 'next_action' })

    expect(isStalled(activeProject(), [waitingTask, nextAction])).toBe(false)
  })

  it.each(['someday', 'done', 'dropped'] as const)(
    'never stalls a %s project, which is not meant to be moving',
    (state) => {
      expect(isStalled(activeProject({ state }), [waitingTask])).toBe(false)
    },
  )
})

describe('completeProject', () => {
  const completedAt = createdAt + 60_000

  it('marks the project done and stamps completedAt', () => {
    const project = completeProject(activeProject(), completedAt)

    expect(project.state).toBe('done')
    expect(project.completedAt).toBe(completedAt)
  })

  // Completing a project does not complete its tasks; the UI flags the leftovers.
  it('leaves open tasks for the caller to surface rather than completing them', () => {
    const tasks = [
      projectTask({ id: 'task-1', title: 'Book travel', status: 'waiting' }),
      projectTask({ id: 'task-2', title: 'Draft slides', status: 'done' }),
    ]

    expect(openTasks(tasks).map((task) => task.id)).toEqual(['task-1'])
  })

  it('reports no open tasks when everything is done', () => {
    const tasks = [projectTask({ id: 'task-1', title: 'Book travel', status: 'done' })]

    expect(openTasks(tasks)).toEqual([])
  })
})

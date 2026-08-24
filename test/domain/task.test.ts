import { describe, expect, it } from 'vitest'
import {
  applyStatusChange,
  blockChange,
  blockRefusal,
  githubTrackedStatuses,
  isDeferred,
  isUntriaged,
  newTask,
  taskStatuses,
  type Task,
  undoStatusChange,
} from '../../src/domain/task.js'

const createdAt = Date.UTC(2026, 0, 1)

/** A saved task, with the fields under test overridable per case. */
function existingTask(overrides: Partial<Task> = {}): Task {
  return {
    ...newTask({ id: 'task-1', title: 'Review the deployment runbook' }, createdAt),
    ...overrides,
  }
}

describe('the eight statuses', () => {
  it('are exactly the ones spec 01 names, and project is not among them', () => {
    expect([...taskStatuses]).toEqual([
      'inbox',
      'next_action',
      'review',
      'waiting',
      'blocked',
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
  // `classifications` is spec 04's, and is asserted in `test/jobs/classify.test.ts`.
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

  // Without a tracked set, the caller has not expressed an opt-out, and an opt-out is
  // permanent. A route that forgets the field must not silently unsubscribe the task.
  it('keeps tracking when the change does not say what the connector tracks', () => {
    const result = applyStatusChange(trackedReviewTask(), {
      status: 'someday',
      by: 'user',
      at: changedAt,
    })

    expect(result.applied).toBe(true)
    expect(result.task.syncTracked).toBe(true)
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

describe('isUntriaged', () => {
  // What licenses sync to retire a duplicate card: nobody has decided anything about it yet.
  // Spec 02, notification emails as a backup source.
  it('is a task still in the inbox that the user did not put there', () => {
    expect(isUntriaged(existingTask({ status: 'inbox', statusSetBy: 'sync' }))).toBe(true)
    expect(isUntriaged(existingTask({ status: 'inbox', statusSetBy: 'llm' }))).toBe(true)
  })

  it('is not a task the user put in the inbox, which is a decision like any other', () => {
    expect(isUntriaged(existingTask({ status: 'inbox', statusSetBy: 'user' }))).toBe(false)
  })

  it.each(taskStatuses.filter((status) => status !== 'inbox'))(
    'is not a task filed in %s',
    (status) => {
      expect(isUntriaged(existingTask({ status, statusSetBy: 'llm' }))).toBe(false)
    },
  )
})

/**
 * Putting a status change back. Spec 01 criteria 8 to 11.
 *
 * Rule 3 of the status rules exists because of rule 2: a change is cheap to make and, when the
 * actor is the user, permanent in its effect, so the cost of a mistake and the cost of making one
 * are badly matched. What is recoverable is the last change and nothing before it.
 */
describe('the previous status pair', () => {
  const at = Date.UTC(2026, 0, 2)

  // Criterion 11.
  it('is null on a task never changed since it was created', () => {
    const task = newTask({ id: 'task-1', title: 'Book the venue' }, createdAt)

    expect(task.previousStatus).toBeNull()
    expect(task.previousStatusSetBy).toBeNull()
    expect(undoStatusChange(task, at)).toEqual({ undone: false, reason: 'nothing-to-undo' })
  })

  // Criterion 8.
  it('records what the status and the actor were immediately before a change', () => {
    const task = existingTask({ status: 'inbox', statusSetBy: 'llm' })

    const result = applyStatusChange(task, { status: 'next_action', by: 'user', at })

    expect(result.applied).toBe(true)
    expect(result.task.previousStatus).toBe('inbox')
    expect(result.task.previousStatusSetBy).toBe('llm')
  })

  // Criterion 8: a second change overwrites the pair rather than accumulating.
  it('keeps one step and not a history', () => {
    const first = applyStatusChange(existingTask({ status: 'inbox', statusSetBy: 'llm' }), {
      status: 'next_action',
      by: 'user',
      at,
    })
    const second = applyStatusChange(first.task, { status: 'someday', by: 'user', at: at + 1 })

    expect(second.task.previousStatus).toBe('next_action')
    expect(second.task.previousStatusSetBy).toBe('user')
  })

  it('is not recorded by a change the rules refused, since nothing changed', () => {
    const refused = applyStatusChange(existingTask({ status: 'someday', statusSetBy: 'user' }), {
      status: 'next_action',
      by: 'llm',
      at,
    })

    expect(refused.applied).toBe(false)
    expect(refused.task.previousStatus).toBeNull()
  })
})

describe('undoStatusChange', () => {
  const at = Date.UTC(2026, 0, 2)
  const undoneAt = Date.UTC(2026, 0, 3)

  /**
   * Criterion 9, and the whole reason the actor is stored beside the status: a board move records
   * `status_set_by = 'user'`, which locks the classifier out of the task for good, so an undo that
   * restored only the status would leave the part that cost anything undone.
   */
  it('restores the actor as well as the status, so the classifier may act again', () => {
    const moved = applyStatusChange(existingTask({ status: 'inbox', statusSetBy: 'llm' }), {
      status: 'someday',
      by: 'user',
      at,
    })

    const result = undoStatusChange(moved.task, undoneAt)

    expect(result).toEqual({
      undone: true,
      task: expect.objectContaining({
        status: 'inbox',
        statusSetBy: 'llm',
        statusSetAt: undoneAt,
      }),
    })

    // And the proof of it: the classifier's next proposal is no longer refused.
    const proposed = applyStatusChange(result.undone ? result.task : moved.task, {
      status: 'next_action',
      by: 'llm',
      at: undoneAt + 1,
    })
    expect(proposed.applied).toBe(true)
  })

  // Criterion 10. Recording the undone state would make undo a toggle and lose what it restored.
  it('does not record the undone state, so it cannot be applied twice to walk further back', () => {
    const moved = applyStatusChange(existingTask({ status: 'inbox', statusSetBy: 'llm' }), {
      status: 'someday',
      by: 'user',
      at,
    })

    const first = undoStatusChange(moved.task, undoneAt)
    expect(first.undone).toBe(true)

    const task = first.undone ? first.task : moved.task
    expect(task.previousStatus).toBeNull()
    expect(task.previousStatusSetBy).toBeNull()
    expect(undoStatusChange(task, undoneAt + 1)).toEqual({
      undone: false,
      reason: 'nothing-to-undo',
    })
  })

  /**
   * The other direction, and the honest limit of it: putting back a completion stamps it at the
   * moment of the undo, because the original stamp is not among the two columns kept. Reopening a
   * task and changing your mind gives it today's completion date, which is observable and is the
   * price of one step rather than a history.
   */
  it('stamps a restored completion at the undo, since the original stamp is not kept', () => {
    const reopened = applyStatusChange(existingTask({ status: 'done' }), {
      status: 'next_action',
      by: 'user',
      at,
    })

    const result = undoStatusChange(reopened.task, undoneAt)

    expect(result.undone && result.task.status).toBe('done')
    expect(result.undone && result.task.completedAt).toBe(undoneAt)
  })

  it('clears the completion stamp when what it restores is not done', () => {
    const completed = applyStatusChange(existingTask({ status: 'next_action' }), {
      status: 'done',
      by: 'user',
      at,
    })

    const result = undoStatusChange(completed.task, undoneAt)

    expect(result.undone && result.task.completedAt).toBeNull()
  })
})

/**
 * Blocking, in the domain: the status and the reference are one fact, and nothing here can set
 * one without the other. Spec 01, criteria 12, 13, 16, 17 and 18.
 */
describe('blocking one task behind another', () => {
  const at = createdAt + 60_000

  /** Criterion 13: naming a blocker is a move to `blocked`, and both halves land together. */
  it('names the blocker and the status together', () => {
    const result = applyStatusChange(existingTask(), blockChange('blocker', 'user', at))

    expect(result).toMatchObject({
      applied: true,
      task: { status: 'blocked', blockedBy: 'blocker', statusSetBy: 'user' },
    })
  })

  /** Criterion 13: clearing it puts the task back where an unblocked concrete action goes. */
  it('returns the task to next_action when the blocker is cleared', () => {
    const blocked = existingTask({ status: 'blocked', blockedBy: 'blocker' })

    const result = applyStatusChange(blocked, blockChange(null, 'user', at))

    expect(result).toMatchObject({
      applied: true,
      task: { status: 'next_action', blockedBy: null },
    })
  })

  /** Criterion 12: half the fact is refused, with its reason, rather than written. */
  it('refuses a move to blocked that names no blocker', () => {
    const result = applyStatusChange(existingTask(), { status: 'blocked', by: 'user', at })

    expect(result).toMatchObject({ applied: false, reason: 'blocker-required' })
  })

  /** Criterion 12: a task that is not blocked holds no blocker, whatever the caller passed. */
  it.each(['someday', 'done', 'inbox'] as const)('clears the blocker on a move to %s', (status) => {
    const blocked = existingTask({ status: 'blocked', blockedBy: 'blocker' })

    const result = applyStatusChange(blocked, { status, by: 'user', at, blockedBy: 'blocker' })

    expect(result).toMatchObject({ applied: true, task: { status, blockedBy: null } })
  })

  /**
   * Criterion 18. The blocker went with the move, and the status cannot stand without one, so
   * the way back is to name it again rather than to undo. That is criterion 16 seen from the
   * other side: the second block is a new decision.
   */
  it('refuses to put a move out of blocked back', () => {
    const moved = existingTask({
      status: 'someday',
      blockedBy: null,
      previousStatus: 'blocked',
      previousStatusSetBy: 'user',
    })

    expect(undoStatusChange(moved, at)).toEqual({
      undone: false,
      reason: 'blocked-needs-blocker',
    })
  })

  /**
   * Criterion 20, the direction the criterion 18 tests do not cover. Restoring the status alone
   * left the reference in place, which is the half fact the check constraint refuses, so what the
   * board offered on every freshly blocked card was a 500.
   */
  it('clears the blocker when it puts a move into blocked back', () => {
    const blocked = existingTask({
      status: 'blocked',
      blockedBy: 'blocker',
      previousStatus: 'next_action',
      previousStatusSetBy: 'user',
    })

    expect(undoStatusChange(blocked, at)).toMatchObject({
      undone: true,
      task: { status: 'next_action', blockedBy: null },
    })
  })
})

/** Criterion 17: a task may not end up behind itself, directly or through a chain. */
describe('blockRefusal', () => {
  /** The chain, as a map from a task to the one it is blocked behind. */
  const chainOf = (chain: Record<string, string>) => (id: string) => chain[id] ?? null

  it("allows a blocker that is not in the task's own chain", () => {
    expect(blockRefusal('a', 'b', chainOf({ b: 'c' }))).toBeNull()
  })

  it('refuses a task blocked behind itself', () => {
    expect(blockRefusal('a', 'a', chainOf({}))).toBe('cycle')
  })

  it('refuses a cycle through a chain of blockers', () => {
    expect(blockRefusal('a', 'c', chainOf({ c: 'b', b: 'a' }))).toBe('cycle')
  })

  /**
   * A database edited by hand can hold a loop the rule was written to prevent. The walk carries
   * the ids it has seen so that reading one cannot hang the process.
   */
  it('terminates on a loop it did not create, rather than hanging', () => {
    expect(blockRefusal('a', 'b', chainOf({ b: 'c', c: 'b' }))).toBeNull()
  })
})

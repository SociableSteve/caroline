/**
 * The filtered, paginated task query the API list route is built on, and the bulk writes
 * behind `POST /api/tasks/bulk`. Spec 08.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '../../../src/db/connection.js'
import { createProject } from '../../../src/db/repositories/projects.js'
import {
  bulkAssignProject,
  bulkChangeStatus,
  createTask,
  listTags,
  listTasks,
  setTaskTags,
} from '../../../src/db/repositories/tasks.js'
import { migratedDatabase } from '../../helpers/temp-database.js'

const createdAt = Date.UTC(2026, 0, 1)
const later = createdAt + 60_000

let database: Database

beforeEach(() => {
  database = migratedDatabase()
})

describe('listTasks with no filters', () => {
  it('returns every task with a total, whatever its status', () => {
    createTask(database, { title: 'Captured', sortOrder: 0 }, createdAt)
    createTask(database, { title: 'Finished', status: 'done', sortOrder: 1 }, createdAt)

    const page = listTasks(database, {}, createdAt)

    expect(page.total).toBe(2)
    expect(page.tasks.map((task) => task.title)).toEqual(['Captured', 'Finished'])
  })

  it('orders by sort order, then creation time, then id', () => {
    createTask(database, { title: 'Third', sortOrder: 2 }, createdAt)
    createTask(database, { title: 'First', sortOrder: 0 }, createdAt)
    createTask(database, { title: 'Second', sortOrder: 1 }, createdAt)

    const page = listTasks(database, {}, createdAt)

    expect(page.tasks.map((task) => task.title)).toEqual(['First', 'Second', 'Third'])
  })
})

describe('listTasks filters', () => {
  it('filters by a single status', () => {
    createTask(database, { title: 'Captured' }, createdAt)
    createTask(database, { title: 'Blocked', status: 'waiting' }, createdAt)

    const page = listTasks(database, { status: ['waiting'] }, createdAt)

    expect(page.tasks.map((task) => task.title)).toEqual(['Blocked'])
    expect(page.total).toBe(1)
  })

  it('filters by several statuses at once, which is what the board asks for', () => {
    createTask(database, { title: 'Captured', sortOrder: 0 }, createdAt)
    createTask(database, { title: 'Blocked', status: 'waiting', sortOrder: 1 }, createdAt)
    createTask(database, { title: 'Finished', status: 'done', sortOrder: 2 }, createdAt)

    const page = listTasks(database, { status: ['inbox', 'waiting'] }, createdAt)

    expect(page.tasks.map((task) => task.title)).toEqual(['Captured', 'Blocked'])
  })

  it('filters by project', () => {
    const project = createProject(database, { title: 'Ship the thing' }, createdAt)
    createTask(database, { title: 'In the project', projectId: project.id }, createdAt)
    createTask(database, { title: 'Loose' }, createdAt)

    const page = listTasks(database, { projectId: project.id }, createdAt)

    expect(page.tasks.map((task) => task.title)).toEqual(['In the project'])
  })

  it('filters to tasks belonging to no project at all', () => {
    const project = createProject(database, { title: 'Ship the thing' }, createdAt)
    createTask(database, { title: 'In the project', projectId: project.id }, createdAt)
    createTask(database, { title: 'Loose' }, createdAt)

    const page = listTasks(database, { projectId: null }, createdAt)

    expect(page.tasks.map((task) => task.title)).toEqual(['Loose'])
  })

  it('filters by tag', () => {
    const tagged = createTask(database, { title: 'Tagged' }, createdAt)
    createTask(database, { title: 'Untagged' }, createdAt)
    setTaskTags(database, tagged.id, ['finance', 'urgent'])

    const page = listTasks(database, { tag: 'finance' }, createdAt)

    expect(page.tasks.map((task) => task.title)).toEqual(['Tagged'])
  })

  it('returns a tagged task once, not once per tag', () => {
    const tagged = createTask(database, { title: 'Tagged' }, createdAt)
    setTaskTags(database, tagged.id, ['finance', 'urgent'])

    const page = listTasks(database, {}, createdAt)

    expect(page.tasks).toHaveLength(1)
    expect(page.total).toBe(1)
  })

  it('filters by due date', () => {
    createTask(database, { title: 'Due soon', dueAt: createdAt }, createdAt)
    createTask(database, { title: 'Due later', dueAt: later + 1 }, createdAt)
    createTask(database, { title: 'No due date' }, createdAt)

    const page = listTasks(database, { dueBefore: later }, createdAt)

    expect(page.tasks.map((task) => task.title)).toEqual(['Due soon'])
  })

  it('searches title and notes, case insensitively', () => {
    createTask(database, { title: 'Renew the Domain', sortOrder: 0 }, createdAt)
    createTask(
      database,
      { title: 'Unrelated', notes: 'the domain expires in March', sortOrder: 1 },
      createdAt,
    )
    createTask(database, { title: 'Nothing to do with it', sortOrder: 2 }, createdAt)

    const page = listTasks(database, { search: 'domain' }, createdAt)

    expect(page.tasks.map((task) => task.title)).toEqual(['Renew the Domain', 'Unrelated'])
  })

  it('treats a search term as literal text rather than a like pattern', () => {
    createTask(database, { title: '100% done, honestly' }, createdAt)
    createTask(database, { title: 'Anything at all' }, createdAt)

    const page = listTasks(database, { search: '100%' }, createdAt)

    expect(page.tasks.map((task) => task.title)).toEqual(['100% done, honestly'])
  })

  it('combines filters rather than choosing between them', () => {
    const project = createProject(database, { title: 'Ship the thing' }, createdAt)
    createTask(
      database,
      { title: 'Wanted', status: 'next_action', projectId: project.id },
      createdAt,
    )
    createTask(database, { title: 'Wrong status', projectId: project.id }, createdAt)
    createTask(database, { title: 'Wrong project', status: 'next_action' }, createdAt)

    const page = listTasks(database, { status: ['next_action'], projectId: project.id }, createdAt)

    expect(page.tasks.map((task) => task.title)).toEqual(['Wanted'])
  })
})

/**
 * Spec 01 criterion 5, at the level the API serves: deferral hides a next action until the
 * moment passes, and hides nothing else. A deferred `waiting` task is still waiting.
 */
describe('listTasks and deferral', () => {
  it('excludes a next action deferred into the future', () => {
    createTask(database, { title: 'Deferred', status: 'next_action', deferUntil: later }, createdAt)

    const page = listTasks(database, { status: ['next_action'] }, createdAt)

    expect(page.tasks).toEqual([])
    expect(page.total).toBe(0)
  })

  it('includes it again once the moment passes', () => {
    createTask(database, { title: 'Deferred', status: 'next_action', deferUntil: later }, createdAt)

    const page = listTasks(database, { status: ['next_action'] }, later)

    expect(page.tasks.map((task) => task.title)).toEqual(['Deferred'])
  })

  it('includes it when the caller asks for deferred tasks explicitly', () => {
    createTask(database, { title: 'Deferred', status: 'next_action', deferUntil: later }, createdAt)

    const page = listTasks(database, { status: ['next_action'], includeDeferred: true }, createdAt)

    expect(page.tasks.map((task) => task.title)).toEqual(['Deferred'])
  })

  it('leaves a deferred task in any other status visible', () => {
    createTask(
      database,
      { title: 'Deferred wait', status: 'waiting', deferUntil: later },
      createdAt,
    )

    const page = listTasks(database, { status: ['waiting'] }, createdAt)

    expect(page.tasks.map((task) => task.title)).toEqual(['Deferred wait'])
  })

  it('hides a deferred next action from an unfiltered listing too', () => {
    createTask(database, { title: 'Deferred', status: 'next_action', deferUntil: later }, createdAt)
    createTask(database, { title: 'Captured' }, createdAt)

    const page = listTasks(database, {}, createdAt)

    expect(page.tasks.map((task) => task.title)).toEqual(['Captured'])
  })
})

describe('listTasks pagination', () => {
  beforeEach(() => {
    for (let index = 0; index < 5; index += 1) {
      createTask(database, { title: `Task ${index}`, sortOrder: index }, createdAt)
    }
  })

  it('returns a window of rows and the unwindowed total', () => {
    const page = listTasks(database, { limit: 2, offset: 1 }, createdAt)

    expect(page.tasks.map((task) => task.title)).toEqual(['Task 1', 'Task 2'])
    expect(page.total).toBe(5)
  })

  it('returns an empty window past the end without failing', () => {
    const page = listTasks(database, { limit: 2, offset: 50 }, createdAt)

    expect(page.tasks).toEqual([])
    expect(page.total).toBe(5)
  })
})

describe('listTags', () => {
  it('returns the tags of several tasks in one query, keyed by task', () => {
    const first = createTask(database, { title: 'First' }, createdAt)
    const second = createTask(database, { title: 'Second' }, createdAt)
    setTaskTags(database, first.id, ['urgent', 'finance'])
    setTaskTags(database, second.id, ['home'])

    const tags = listTags(database, [first.id, second.id])

    expect(tags.get(first.id)).toEqual(['finance', 'urgent'])
    expect(tags.get(second.id)).toEqual(['home'])
  })

  it('omits a task with no tags rather than inventing an entry', () => {
    const task = createTask(database, { title: 'Untagged' }, createdAt)

    expect(listTags(database, [task.id]).has(task.id)).toBe(false)
  })

  it('returns nothing for no tasks, without running a query for it', () => {
    expect(listTags(database, [])).toEqual(new Map())
  })
})

describe('bulkChangeStatus', () => {
  it('applies the change to every task named', () => {
    const first = createTask(database, { title: 'First' }, createdAt)
    const second = createTask(database, { title: 'Second' }, createdAt)

    const results = bulkChangeStatus(database, [first.id, second.id], {
      status: 'next_action',
      by: 'user',
      at: later,
    })

    expect(results.map((result) => result.applied)).toEqual([true, true])
    expect(listTasks(database, { status: ['next_action'] }, later).total).toBe(2)
  })

  it('reports a missing task rather than failing the whole batch', () => {
    const task = createTask(database, { title: 'First' }, createdAt)

    const results = bulkChangeStatus(database, [task.id, 'no-such-task'], {
      status: 'someday',
      by: 'user',
      at: later,
    })

    expect(results).toEqual([
      { id: task.id, applied: true },
      { id: 'no-such-task', applied: false, reason: 'not-found' },
    ])
  })

  /**
   * The failure has to land on the second task for this to be about rollback at all: a batch
   * that dies on the first write has nothing to undo. A trigger refuses one named task, which
   * is the only way to fail a write that the repository itself considers valid.
   */
  it('rolls the earlier writes back when a later one fails', () => {
    const first = createTask(database, { title: 'First' }, createdAt)
    const second = createTask(database, { title: 'Second' }, createdAt)
    database.exec(`
      create trigger refuse_second before update on tasks
      when new.id = '${second.id}'
      begin select raise(abort, 'this write is refused'); end
    `)

    expect(() =>
      bulkChangeStatus(database, [first.id, second.id], {
        status: 'someday',
        by: 'user',
        at: later,
      }),
    ).toThrow('this write is refused')

    // Both, not just the one that failed: the batch is one transaction.
    expect(listTasks(database, { status: ['inbox'] }, later).total).toBe(2)
  })

  it('rolls back when the very first write fails', () => {
    const task = createTask(database, { title: 'First' }, createdAt)

    expect(() =>
      bulkChangeStatus(database, [task.id], {
        status: 'not-a-status' as never,
        by: 'user',
        at: later,
      }),
    ).toThrow()
    expect(listTasks(database, { status: ['inbox'] }, later).total).toBe(1)
  })

  /**
   * `reason` on a bulk result can carry a domain refusal, not only `not-found`. Reachable
   * from here but not through the API, which always acts as the user: the rules only ever
   * refuse the classifier and sync.
   */
  it('reports a domain refusal with the reason the rules gave', () => {
    const task = createTask(database, { title: 'Decided by hand' }, createdAt)

    const results = bulkChangeStatus(database, [task.id], {
      status: 'someday',
      by: 'llm',
      at: later,
    })

    expect(results).toEqual([{ id: task.id, applied: false, reason: 'user-set' }])
    expect(listTasks(database, { status: ['inbox'] }, later).total).toBe(1)
  })
})

describe('bulkAssignProject', () => {
  it('moves every task named into the project', () => {
    const project = createProject(database, { title: 'Ship the thing' }, createdAt)
    const first = createTask(database, { title: 'First' }, createdAt)
    const second = createTask(database, { title: 'Second' }, createdAt)

    const results = bulkAssignProject(database, [first.id, second.id], project.id, later)

    expect(results.map((result) => result.applied)).toEqual([true, true])
    expect(listTasks(database, { projectId: project.id }, later).total).toBe(2)
  })

  it('takes a task out of a project when passed null', () => {
    const project = createProject(database, { title: 'Ship the thing' }, createdAt)
    const task = createTask(database, { title: 'First', projectId: project.id }, createdAt)

    bulkAssignProject(database, [task.id], null, later)

    expect(listTasks(database, { projectId: null }, later).total).toBe(1)
  })

  it('reports a missing task rather than failing the whole batch', () => {
    const results = bulkAssignProject(database, ['no-such-task'], null, later)

    expect(results).toEqual([{ id: 'no-such-task', applied: false, reason: 'not-found' }])
  })
})

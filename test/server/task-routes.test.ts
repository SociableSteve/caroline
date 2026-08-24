/**
 * The task routes. Spec 08: every route declares a schema, a violation is a 400 in the
 * standard error shape, and a status change made through the API is the user's.
 */
import { describe, expect, it } from 'vitest'
import { createProject } from '../../src/db/repositories/projects.js'
import { createTask, getTask, setTaskTags } from '../../src/db/repositories/tasks.js'
import { upsertSource } from '../../src/db/repositories/sources.js'
import { REQUEST_TIME, testServer } from '../helpers/test-server.js'

const earlier = REQUEST_TIME - 60_000

describe('GET /api/tasks', () => {
  it('returns an empty page on an empty database rather than failing', async () => {
    const { app } = await testServer()

    const response = await app.inject({ method: 'GET', url: '/api/tasks' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ tasks: [], total: 0, limit: 200, offset: 0 })
  })

  it('returns a task with its tags', async () => {
    const { app, database } = await testServer()
    const task = createTask(database, { title: 'Renew the domain' }, earlier)
    setTaskTags(database, task.id, ['admin'])

    const body = (await app.inject({ method: 'GET', url: '/api/tasks' })).json()

    expect(body.tasks).toEqual([
      {
        id: task.id,
        title: 'Renew the domain',
        notes: null,
        status: 'inbox',
        projectId: null,
        sortOrder: 0,
        estimateMinutes: null,
        dueAt: null,
        deferUntil: null,
        waitingOn: null,
        // Behind nothing, which is every task but the few that are. Spec 01, criterion 12.
        blockedBy: null,
        statusSetBy: 'user',
        statusSetAt: earlier,
        // Never changed since capture, so there is nothing to put back. Spec 01, criterion 11.
        previousStatus: null,
        previousStatusSetBy: null,
        syncTracked: false,
        createdAt: earlier,
        updatedAt: earlier,
        completedAt: null,
        tags: ['admin'],
        // Manual capture has no provenance. A task from a connector carries its source here.
        sources: [],
        // Nothing the classifier has an opinion about, which is every manually captured task.
        proposal: null,
      },
    ])
  })

  it('filters by status, including several at once', async () => {
    const { app, database } = await testServer()
    createTask(database, { title: 'Captured' }, earlier)
    createTask(database, { title: 'Blocked', status: 'waiting' }, earlier)
    createTask(database, { title: 'Finished', status: 'done' }, earlier)

    const body = (
      await app.inject({ method: 'GET', url: '/api/tasks?status=inbox&status=waiting' })
    ).json()

    expect(body.tasks.map((task: { title: string }) => task.title).sort()).toEqual([
      'Blocked',
      'Captured',
    ])
  })

  it('accepts a single status, which the array schema coerces', async () => {
    const { app, database } = await testServer()
    createTask(database, { title: 'Captured' }, earlier)
    createTask(database, { title: 'Blocked', status: 'waiting' }, earlier)

    const body = (await app.inject({ method: 'GET', url: '/api/tasks?status=waiting' })).json()

    expect(body.tasks.map((task: { title: string }) => task.title)).toEqual(['Blocked'])
  })

  it('filters by project, tag, due date and search', async () => {
    const { app, database } = await testServer()
    const project = createProject(database, { title: 'Ship it' }, earlier)
    const wanted = createTask(
      database,
      { title: 'Renew the domain', projectId: project.id, dueAt: earlier },
      earlier,
    )
    setTaskTags(database, wanted.id, ['admin'])
    createTask(database, { title: 'Something else' }, earlier)

    const url = `/api/tasks?projectId=${project.id}&tag=admin&dueBefore=${REQUEST_TIME}&search=domain`
    const body = (await app.inject({ method: 'GET', url })).json()

    expect(body.tasks).toHaveLength(1)
    expect(body.tasks[0].id).toBe(wanted.id)
  })

  it('pages, reporting the total behind the window', async () => {
    const { app, database } = await testServer()
    for (let index = 0; index < 3; index += 1) {
      createTask(database, { title: `Task ${index}`, sortOrder: index }, earlier)
    }

    const body = (await app.inject({ method: 'GET', url: '/api/tasks?limit=1&offset=1' })).json()

    expect(body).toMatchObject({ total: 3, limit: 1, offset: 1 })
    expect(body.tasks.map((task: { title: string }) => task.title)).toEqual(['Task 1'])
  })

  it('hides a deferred next action, and shows it when asked to', async () => {
    const { app, database } = await testServer()
    createTask(
      database,
      { title: 'Later', status: 'next_action', deferUntil: REQUEST_TIME + 60_000 },
      earlier,
    )

    const hidden = (await app.inject({ method: 'GET', url: '/api/tasks' })).json()
    const shown = (
      await app.inject({ method: 'GET', url: '/api/tasks?includeDeferred=true' })
    ).json()

    expect(hidden.tasks).toEqual([])
    expect(shown.tasks).toHaveLength(1)
  })

  it('rejects an unknown status in the standard error shape', async () => {
    const { app } = await testServer()

    const response = await app.inject({ method: 'GET', url: '/api/tasks?status=procrastinating' })

    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('bad_request')
    expect(typeof response.json().error.message).toBe('string')
  })

  it('rejects an unknown query parameter', async () => {
    const { app } = await testServer()

    const response = await app.inject({ method: 'GET', url: '/api/tasks?sortBy=whatever' })

    expect(response.statusCode).toBe(400)
  })

  it('rejects a limit beyond the cap rather than serving the whole table', async () => {
    const { app } = await testServer()

    const response = await app.inject({ method: 'GET', url: '/api/tasks?limit=100000' })

    expect(response.statusCode).toBe(400)
  })
})

describe('POST /api/tasks', () => {
  it('creates an inbox task attributed to the user, stamped with the request time', async () => {
    const { app } = await testServer()

    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { title: 'Renew the domain' },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({
      title: 'Renew the domain',
      status: 'inbox',
      statusSetBy: 'user',
      statusSetAt: REQUEST_TIME,
      createdAt: REQUEST_TIME,
      tags: [],
    })
  })

  it('accepts every field the board can set, tags included', async () => {
    const { app, database } = await testServer()
    const project = createProject(database, { title: 'Ship it' }, earlier)

    const body = (
      await app.inject({
        method: 'POST',
        url: '/api/tasks',
        payload: {
          title: 'Chase the invoice',
          notes: 'Sent in January',
          status: 'waiting',
          projectId: project.id,
          sortOrder: 3,
          estimateMinutes: 15,
          dueAt: REQUEST_TIME,
          deferUntil: REQUEST_TIME,
          waitingOn: 'Accounts',
          tags: ['finance', 'chase'],
        },
      })
    ).json()

    expect(body).toMatchObject({
      status: 'waiting',
      projectId: project.id,
      sortOrder: 3,
      estimateMinutes: 15,
      waitingOn: 'Accounts',
    })
    expect(body.tags).toEqual(['chase', 'finance'])
  })

  /**
   * Both kinds, because a task write can change a project's derived next action and stalled
   * flag without touching the projects table.
   */
  it('announces the change on the feed', async () => {
    const { app, published } = await testServer()

    await app.inject({ method: 'POST', url: '/api/tasks', payload: { title: 'Anything' } })

    expect(published).toEqual([
      { kind: 'tasks', at: REQUEST_TIME },
      { kind: 'projects', at: REQUEST_TIME },
    ])
  })

  it('rejects a missing title', async () => {
    const { app } = await testServer()

    const response = await app.inject({ method: 'POST', url: '/api/tasks', payload: {} })

    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('bad_request')
  })

  it('rejects an empty title', async () => {
    const { app } = await testServer()

    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { title: '   ' },
    })

    expect(response.statusCode).toBe(400)
  })

  it('rejects a field it does not know', async () => {
    const { app } = await testServer()

    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { title: 'Fine', statusSetBy: 'llm' },
    })

    expect(response.statusCode).toBe(400)
  })

  it('rejects a project that does not exist, rather than failing with a 500', async () => {
    const { app } = await testServer()

    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { title: 'Fine', projectId: 'no-such-project' },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('bad_request')
  })
})

describe('PATCH /api/tasks/:id', () => {
  it('updates the fields it is given and leaves the rest alone', async () => {
    const { app, database } = await testServer()
    const task = createTask(database, { title: 'Renew the domain', notes: 'Keep me' }, earlier)

    const body = (
      await app.inject({
        method: 'PATCH',
        url: `/api/tasks/${task.id}`,
        payload: { title: 'Renew the domain properly', estimateMinutes: 20 },
      })
    ).json()

    expect(body).toMatchObject({
      title: 'Renew the domain properly',
      notes: 'Keep me',
      estimateMinutes: 20,
      updatedAt: REQUEST_TIME,
    })
  })

  it('replaces the tag set when tags are given', async () => {
    const { app, database } = await testServer()
    const task = createTask(database, { title: 'Renew the domain' }, earlier)
    setTaskTags(database, task.id, ['old'])

    const body = (
      await app.inject({
        method: 'PATCH',
        url: `/api/tasks/${task.id}`,
        payload: { tags: ['new'] },
      })
    ).json()

    expect(body.tags).toEqual(['new'])
  })

  /** Criterion 3: a status set through the API is set by the user, whatever set it before. */
  it('records a status change as the user’s', async () => {
    const { app, database } = await testServer()
    const task = createTask(
      database,
      { title: 'From the classifier', status: 'inbox', statusSetBy: 'llm' },
      earlier,
    )

    const body = (
      await app.inject({
        method: 'PATCH',
        url: `/api/tasks/${task.id}`,
        payload: { status: 'next_action' },
      })
    ).json()

    expect(body).toMatchObject({
      status: 'next_action',
      statusSetBy: 'user',
      statusSetAt: REQUEST_TIME,
    })
  })

  /**
   * Spec 01: filing a tracked item outside its connector's set is a permanent opt-out, and
   * the API is the only place the user can do it.
   */
  it('keeps a tracked task tracked when the user moves it within the tracked set', async () => {
    const { app, database } = await testServer()
    const task = createTask(
      database,
      { title: 'Review the PR', status: 'review', statusSetBy: 'sync' },
      earlier,
    )
    upsertSource(
      database,
      { provider: 'github', externalId: 'owner/repo#1', taskId: task.id },
      earlier,
    )

    const body = (
      await app.inject({
        method: 'PATCH',
        url: `/api/tasks/${task.id}`,
        payload: { status: 'waiting' },
      })
    ).json()

    expect(body.syncTracked).toBe(true)
  })

  it('stops tracking when the user files a tracked task outside the set', async () => {
    const { app, database } = await testServer()
    const task = createTask(
      database,
      { title: 'Review the PR', status: 'review', statusSetBy: 'sync' },
      earlier,
    )
    upsertSource(
      database,
      { provider: 'github', externalId: 'owner/repo#1', taskId: task.id },
      earlier,
    )

    const body = (
      await app.inject({
        method: 'PATCH',
        url: `/api/tasks/${task.id}`,
        payload: { status: 'someday' },
      })
    ).json()

    expect(body.syncTracked).toBe(false)
  })

  /**
   * Criterion 21, on both spellings of the same act. The reference-only patch is what the
   * board's blocker picker sends and the combined one is what a client naming both halves
   * sends, and a task cannot be tracked down one and untracked down the other.
   */
  for (const [spelling, payloadFor] of [
    ['naming the blocker alone', (blockerId: string) => ({ blockedBy: blockerId })],
    [
      'naming the status and the blocker together',
      (blockerId: string) => ({ status: 'blocked', blockedBy: blockerId }),
    ],
  ] as const) {
    it(`keeps a tracked task tracked when it is blocked by ${spelling}`, async () => {
      const { app, database } = await testServer()
      const task = createTask(
        database,
        { title: 'Review the PR', status: 'review', statusSetBy: 'sync' },
        earlier,
      )
      upsertSource(
        database,
        { provider: 'github', externalId: 'owner/repo#1', taskId: task.id },
        earlier,
      )
      const blocker = createTask(database, { title: 'Agree the API shape' }, earlier)

      const body = (
        await app.inject({
          method: 'PATCH',
          url: `/api/tasks/${task.id}`,
          payload: payloadFor(blocker.id),
        })
      ).json()

      expect(body.status).toBe('blocked')
      expect(body.blockedBy).toBe(blocker.id)
      expect(body.syncTracked).toBe(true)
    })
  }

  // Criterion 21, the move back out, on both spellings again.
  for (const [spelling, payload] of [
    ['clearing the blocker', { blockedBy: null }],
    ['moving the card to next actions', { status: 'next_action' }],
  ] as const) {
    it(`keeps a tracked task tracked when it is unblocked by ${spelling}`, async () => {
      const { app, database } = await testServer()
      const blocker = createTask(database, { title: 'Agree the API shape' }, earlier)
      const task = createTask(
        database,
        { title: 'Review the PR', status: 'review', statusSetBy: 'sync' },
        earlier,
      )
      upsertSource(
        database,
        { provider: 'github', externalId: 'owner/repo#1', taskId: task.id },
        earlier,
      )
      await app.inject({
        method: 'PATCH',
        url: `/api/tasks/${task.id}`,
        payload: { blockedBy: blocker.id },
      })

      const body = (
        await app.inject({ method: 'PATCH', url: `/api/tasks/${task.id}`, payload })
      ).json()

      expect(body.status).toBe('next_action')
      expect(body.blockedBy).toBeNull()
      expect(body.syncTracked).toBe(true)
    })
  }

  it('announces the change on the feed', async () => {
    const { app, database, published } = await testServer()
    const task = createTask(database, { title: 'Renew the domain' }, earlier)

    await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${task.id}`,
      payload: { title: 'Renewed' },
    })

    expect(published).toEqual([
      { kind: 'tasks', at: REQUEST_TIME },
      { kind: 'projects', at: REQUEST_TIME },
    ])
  })

  it('answers 404 for a task that does not exist', async () => {
    const { app } = await testServer()

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/tasks/no-such-task',
      payload: { title: 'Anything' },
    })

    expect(response.statusCode).toBe(404)
    expect(response.json().error.code).toBe('not_found')
  })

  it('rejects an empty patch rather than pretending to have done something', async () => {
    const { app, database } = await testServer()
    const task = createTask(database, { title: 'Renew the domain' }, earlier)

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${task.id}`,
      payload: {},
    })

    expect(response.statusCode).toBe(400)
  })

  it('rejects a project that does not exist', async () => {
    const { app, database } = await testServer()
    const task = createTask(database, { title: 'Renew the domain' }, earlier)

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${task.id}`,
      payload: { projectId: 'no-such-project' },
    })

    expect(response.statusCode).toBe(400)
  })

  it('accepts null to clear a nullable field', async () => {
    const { app, database } = await testServer()
    const task = createTask(database, { title: 'Renew the domain', dueAt: earlier }, earlier)

    const body = (
      await app.inject({
        method: 'PATCH',
        url: `/api/tasks/${task.id}`,
        payload: { dueAt: null },
      })
    ).json()

    expect(body.dueAt).toBeNull()
  })
})

describe('POST /api/tasks/:id/complete', () => {
  it('completes the task and stamps the completion', async () => {
    const { app, database } = await testServer()
    const task = createTask(database, { title: 'Renew the domain' }, earlier)

    const body = (
      await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/complete` })
    ).json()

    expect(body).toMatchObject({
      status: 'done',
      statusSetBy: 'user',
      completedAt: REQUEST_TIME,
    })
  })

  it('announces the change on the feed', async () => {
    const { app, database, published } = await testServer()
    const task = createTask(database, { title: 'Renew the domain' }, earlier)

    await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/complete` })

    expect(published.map((event) => event.kind)).toEqual(['tasks', 'projects'])
  })

  it('answers 404 for a task that does not exist', async () => {
    const { app } = await testServer()

    const response = await app.inject({ method: 'POST', url: '/api/tasks/nope/complete' })

    expect(response.statusCode).toBe(404)
  })
})

describe('DELETE /api/tasks/:id', () => {
  it('deletes the task and answers 204', async () => {
    const { app, database } = await testServer()
    const task = createTask(database, { title: 'Renew the domain' }, earlier)

    const response = await app.inject({ method: 'DELETE', url: `/api/tasks/${task.id}` })

    expect(response.statusCode).toBe(204)
    expect(getTask(database, task.id)).toBeNull()
  })

  it('announces the change on the feed', async () => {
    const { app, database, published } = await testServer()
    const task = createTask(database, { title: 'Renew the domain' }, earlier)

    await app.inject({ method: 'DELETE', url: `/api/tasks/${task.id}` })

    expect(published.map((event) => event.kind)).toEqual(['tasks', 'projects'])
  })

  it('answers 404 for a task that does not exist', async () => {
    const { app } = await testServer()

    const response = await app.inject({ method: 'DELETE', url: '/api/tasks/no-such-task' })

    expect(response.statusCode).toBe(404)
  })
})

/**
 * Spec 08, criteria 16 and 17. Its own route because `PATCH` cannot express it: the API is the
 * user, and a user cannot claim to be the classifier, which is exactly what restoring the previous
 * actor amounts to.
 */
describe('POST /api/tasks/:id/undo-status', () => {
  it('restores the previous status and the previous actor', async () => {
    const { app, database } = await testServer()
    const task = createTask(
      database,
      { title: 'Read the newsletter', status: 'inbox', statusSetBy: 'llm' },
      earlier,
    )

    await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${task.id}`,
      payload: { status: 'someday' },
    })
    const moved = getTask(database, task.id)
    expect(moved?.statusSetBy).toBe('user')

    const body = (
      await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/undo-status` })
    ).json()

    expect(body).toMatchObject({ status: 'inbox', statusSetBy: 'llm' })
  })

  // The part that matters: the task is once again one the classifier may act on.
  it('puts the task back within the classifier’s reach', async () => {
    const { app, database } = await testServer()
    const task = createTask(
      database,
      { title: 'Read the newsletter', status: 'inbox', statusSetBy: 'sync' },
      earlier,
    )

    await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${task.id}`,
      payload: { status: 'reference' },
    })
    await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/undo-status` })

    const restored = getTask(database, task.id)
    expect(restored?.statusSetBy).not.toBe('user')
  })

  // Criterion 17: only the most recent change, and only while there is one.
  it('answers 409 where there is nothing to put back', async () => {
    const { app, database } = await testServer()
    const task = createTask(database, { title: 'Book the venue' }, earlier)

    const response = await app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/undo-status`,
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().error.code).toBe('conflict')
  })

  it('answers 409 to a second undo, so it cannot walk back through a history', async () => {
    const { app, database } = await testServer()
    const task = createTask(database, { title: 'Book the venue' }, earlier)

    await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${task.id}`,
      payload: { status: 'someday' },
    })
    const first = await app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/undo-status`,
    })
    const second = await app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/undo-status`,
    })

    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(409)
  })

  it('answers 404 for a task that does not exist', async () => {
    const { app } = await testServer()

    const response = await app.inject({ method: 'POST', url: '/api/tasks/nope/undo-status' })

    expect(response.statusCode).toBe(404)
  })
})

describe('POST /api/tasks/:id/tracking', () => {
  it('re-enables tracking a task had opted out of', async () => {
    const { app, database } = await testServer()
    const task = createTask(
      database,
      { title: 'Review the PR', status: 'someday', statusSetBy: 'sync' },
      earlier,
    )

    const body = (
      await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/tracking` })
    ).json()

    expect(body.syncTracked).toBe(true)
  })

  it('turns tracking off when asked to', async () => {
    const { app, database } = await testServer()
    const task = createTask(
      database,
      { title: 'Review the PR', status: 'review', statusSetBy: 'sync' },
      earlier,
    )

    const body = (
      await app.inject({
        method: 'POST',
        url: `/api/tasks/${task.id}/tracking`,
        payload: { enabled: false },
      })
    ).json()

    expect(body.syncTracked).toBe(false)
  })

  it('answers 404 for a task that does not exist', async () => {
    const { app } = await testServer()

    const response = await app.inject({ method: 'POST', url: '/api/tasks/nope/tracking' })

    expect(response.statusCode).toBe(404)
  })
})

describe('POST /api/tasks/bulk', () => {
  it('changes the status of every task named', async () => {
    const { app, database } = await testServer()
    const first = createTask(database, { title: 'First' }, earlier)
    const second = createTask(database, { title: 'Second' }, earlier)

    const body = (
      await app.inject({
        method: 'POST',
        url: '/api/tasks/bulk',
        payload: { ids: [first.id, second.id], status: 'someday' },
      })
    ).json()

    expect(body.results).toEqual([
      { id: first.id, applied: true },
      { id: second.id, applied: true },
    ])
    expect(getTask(database, first.id)?.status).toBe('someday')
    expect(getTask(database, first.id)?.statusSetBy).toBe('user')
  })

  it('assigns every task named to a project', async () => {
    const { app, database } = await testServer()
    const project = createProject(database, { title: 'Ship it' }, earlier)
    const task = createTask(database, { title: 'First' }, earlier)

    await app.inject({
      method: 'POST',
      url: '/api/tasks/bulk',
      payload: { ids: [task.id], projectId: project.id },
    })

    expect(getTask(database, task.id)?.projectId).toBe(project.id)
  })

  it('reports a task it could not find without failing the request', async () => {
    const { app, database } = await testServer()
    const task = createTask(database, { title: 'First' }, earlier)

    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks/bulk',
      payload: { ids: [task.id, 'no-such-task'], status: 'someday' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().results).toEqual([
      { id: task.id, applied: true },
      { id: 'no-such-task', applied: false, reason: 'not-found' },
    ])
  })

  it('rejects a body asking for neither a status nor a project', async () => {
    const { app } = await testServer()

    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks/bulk',
      payload: { ids: ['whatever'] },
    })

    expect(response.statusCode).toBe(400)
  })

  it('rejects a body asking for both at once', async () => {
    const { app } = await testServer()

    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks/bulk',
      payload: { ids: ['whatever'], status: 'someday', projectId: null },
    })

    expect(response.statusCode).toBe(400)
  })

  it('rejects an empty list of ids', async () => {
    const { app } = await testServer()

    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks/bulk',
      payload: { ids: [], status: 'someday' },
    })

    expect(response.statusCode).toBe(400)
  })

  it('rejects a project that does not exist', async () => {
    const { app, database } = await testServer()
    const task = createTask(database, { title: 'First' }, earlier)

    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks/bulk',
      payload: { ids: [task.id], projectId: 'no-such-project' },
    })

    expect(response.statusCode).toBe(400)
    expect(getTask(database, task.id)?.projectId).toBeNull()
  })
})

/**
 * Blocking over the API. Spec 08, criterion 52: `blockedBy` is one field, set on create or on
 * patch, and the status follows from it rather than being sent beside it.
 */
describe('blockedBy on the task routes', () => {
  it('files a task as blocked when a patch names the blocker', async () => {
    const { app, database } = await testServer()
    const blocker = createTask(database, { title: 'Sign the contract' }, earlier)
    const task = createTask(database, { title: 'Book the venue' }, earlier)

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${task.id}`,
      payload: { blockedBy: blocker.id },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ status: 'blocked', blockedBy: blocker.id })
  })

  it('returns the task to next actions when the patch clears it', async () => {
    const { app, database } = await testServer()
    const blocker = createTask(database, { title: 'Sign the contract' }, earlier)
    const task = createTask(database, { title: 'Book the venue' }, earlier)
    await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${task.id}`,
      payload: { blockedBy: blocker.id },
    })

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${task.id}`,
      payload: { blockedBy: null },
    })

    expect(response.json()).toMatchObject({ status: 'next_action', blockedBy: null })
  })

  it('creates a task already blocked when the body names a blocker', async () => {
    const { app, database } = await testServer()
    const blocker = createTask(database, { title: 'Sign the contract' }, earlier)

    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { title: 'Book the venue', blockedBy: blocker.id },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({ status: 'blocked', blockedBy: blocker.id })
  })

  it('is a 400 naming a blocker that does not exist, on create and on patch alike', async () => {
    const { app, database } = await testServer()
    const task = createTask(database, { title: 'Book the venue' }, earlier)

    const created = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { title: 'Another', blockedBy: 'nonexistent' },
    })
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${task.id}`,
      payload: { blockedBy: 'nonexistent' },
    })

    expect(created.statusCode).toBe(400)
    expect(patched.statusCode).toBe(400)
    expect(patched.json()).toMatchObject({ error: { code: 'bad_request' } })
  })

  /** Criterion 17, over the wire: named rather than left to the constraint to raise as a 500. */
  it('is a 400 for a blocker that would come back round to the task', async () => {
    const { app, database } = await testServer()
    const first = createTask(database, { title: 'One' }, earlier)
    const second = createTask(database, { title: 'Two' }, earlier)
    await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${second.id}`,
      payload: { blockedBy: first.id },
    })

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${first.id}`,
      payload: { blockedBy: second.id },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error.message).toMatch(/behind itself/i)
    expect(getTask(database, first.id)).toMatchObject({ status: 'inbox', blockedBy: null })
  })

  /** Spec 01, criterion 15: the delete releases what was behind it before the row goes. */
  it('releases what was blocked behind a task the delete route removes', async () => {
    const { app, database } = await testServer()
    const blocker = createTask(database, { title: 'Sign the contract' }, earlier)
    const task = createTask(database, { title: 'Book the venue' }, earlier)
    await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${task.id}`,
      payload: { blockedBy: blocker.id },
    })

    await app.inject({ method: 'DELETE', url: `/api/tasks/${blocker.id}` })

    expect(getTask(database, task.id)).toMatchObject({ status: 'next_action', blockedBy: null })
  })

  /** Spec 01, criterion 18: the undo says why rather than restoring half a fact. */
  it('refuses to put a move out of blocked back, and says what to do instead', async () => {
    const { app, database } = await testServer()
    const blocker = createTask(database, { title: 'Sign the contract' }, earlier)
    const task = createTask(database, { title: 'Book the venue' }, earlier)
    await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${task.id}`,
      payload: { blockedBy: blocker.id },
    })
    await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${task.id}`,
      payload: { status: 'someday' },
    })

    const response = await app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/undo-status`,
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().error.message).toMatch(/name the blocker again/i)
  })

  /**
   * Spec 01, criterion 20: the other direction of the undo, which is not refused but does have to
   * take the reference with it. Two clicks from an ordinary block, and it used to be a 500 from the
   * check constraint.
   */
  it('clears the blocker when it puts a move into blocked back', async () => {
    const { app, database } = await testServer()
    const blocker = createTask(database, { title: 'Sign the contract' }, earlier)
    const task = createTask(database, { title: 'Book the venue' }, earlier)
    await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${task.id}`,
      payload: { blockedBy: blocker.id },
    })

    const response = await app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/undo-status`,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ status: 'inbox', blockedBy: null })
    expect(getTask(database, task.id)).toMatchObject({ status: 'inbox', blockedBy: null })
  })

  /**
   * Spec 01, criterion 12: the one create path that could hold half the fact. The bulk route
   * already refuses the same input, so this is the sibling being made to behave the same way
   * rather than crashing on the check constraint.
   */
  it('is a 400 for a create asking for blocked with no blocker named', async () => {
    const { app } = await testServer()

    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { title: 'Book the venue', status: 'blocked' },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error.message).toMatch(/blockedBy/i)
  })

  /**
   * Spec 01, criterion 19. Nothing releases it: the release runs on the transition to `done`, and
   * that moment has passed, so accepting this would file the task in Blocked for good.
   */
  it('is a 400 naming a blocker that is already done, on create and on patch alike', async () => {
    const { app, database } = await testServer()
    const blocker = createTask(database, { title: 'Sign the contract', status: 'done' }, earlier)
    const task = createTask(database, { title: 'Book the venue' }, earlier)

    const created = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { title: 'Another', blockedBy: blocker.id },
    })
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${task.id}`,
      payload: { blockedBy: blocker.id },
    })

    expect([created.statusCode, patched.statusCode]).toEqual([400, 400])
    expect(created.json().error.message).toMatch(/already done/i)
    expect(patched.json().error.message).toMatch(/already done/i)
    expect(getTask(database, task.id)).toMatchObject({ status: 'inbox', blockedBy: null })
  })

  /**
   * Spec 08, criterion 55. The create route already refuses this; the patch route used to accept
   * it, refuse the write under the invariant deep inside the transaction, and answer 200 with the
   * task exactly as it was. A success that changed nothing is worse than either a refusal or a
   * write, because the caller has been told the move happened.
   */
  it('is a 400 for a patch asking for blocked with no blocker named, and writes nothing', async () => {
    const { app, database } = await testServer()
    const task = createTask(database, { title: 'Book the venue', notes: 'the old note' }, earlier)

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${task.id}`,
      payload: { status: 'blocked', notes: 'the new note' },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error.message).toMatch(/blockedBy/i)
    expect(getTask(database, task.id)).toMatchObject({
      status: 'inbox',
      blockedBy: null,
      notes: 'the old note',
    })
  })

  /**
   * The same criterion's other half, as a guard rather than a repair: a patch may send both, and
   * they have to stay one status change rather than two, since a second would overwrite
   * `previous_status` with `blocked` and spend the single step of undo on the move just made.
   * `previousStatus` is what says which of the two happened.
   */
  it('applies a patch sending the status and the blocker together as one status change', async () => {
    const { app, database } = await testServer()
    const blocker = createTask(database, { title: 'Sign the contract' }, earlier)
    const task = createTask(database, { title: 'Book the venue' }, earlier)

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${task.id}`,
      payload: { status: 'blocked', blockedBy: blocker.id },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ status: 'blocked', blockedBy: blocker.id })
    expect(getTask(database, task.id)).toMatchObject({
      status: 'blocked',
      blockedBy: blocker.id,
      previousStatus: 'inbox',
    })
  })

  /**
   * A patch naming only the status of a task that is already blocked names no blocker either, so
   * it is the same half a fact as the one above: the reference is not the caller's to leave out.
   */
  it('is a 400 for a patch restating blocked on a task that is already blocked', async () => {
    const { app, database } = await testServer()
    const blocker = createTask(database, { title: 'Sign the contract' }, earlier)
    const task = createTask(database, { title: 'Book the venue' }, earlier)
    await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${task.id}`,
      payload: { blockedBy: blocker.id },
    })

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${task.id}`,
      payload: { status: 'blocked' },
    })

    expect(response.statusCode).toBe(400)
    expect(getTask(database, task.id)).toMatchObject({
      status: 'blocked',
      blockedBy: blocker.id,
    })
  })
})

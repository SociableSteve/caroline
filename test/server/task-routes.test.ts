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
        statusSetBy: 'user',
        statusSetAt: earlier,
        syncTracked: false,
        createdAt: earlier,
        updatedAt: earlier,
        completedAt: null,
        tags: ['admin'],
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

  it('announces the change on the feed', async () => {
    const { app, published } = await testServer()

    await app.inject({ method: 'POST', url: '/api/tasks', payload: { title: 'Anything' } })

    expect(published).toEqual([{ kind: 'tasks', at: REQUEST_TIME }])
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

  it('announces the change on the feed', async () => {
    const { app, database, published } = await testServer()
    const task = createTask(database, { title: 'Renew the domain' }, earlier)

    await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${task.id}`,
      payload: { title: 'Renewed' },
    })

    expect(published).toEqual([{ kind: 'tasks', at: REQUEST_TIME }])
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

  it('answers 404 for a task that does not exist', async () => {
    const { app } = await testServer()

    const response = await app.inject({ method: 'DELETE', url: '/api/tasks/no-such-task' })

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

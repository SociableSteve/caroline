/**
 * The project routes, including the two derived fields the UI depends on: the next action
 * and the stalled flag. Spec 08, and spec 01 criteria 4 and 6.
 */
import { describe, expect, it } from 'vitest'
import { getProject, listProjects } from '../../src/db/repositories/projects.js'
import { createTask, getTask } from '../../src/db/repositories/tasks.js'
import { REQUEST_TIME, testServer } from '../helpers/test-server.js'

const earlier = REQUEST_TIME - 60_000

describe('GET /api/projects', () => {
  it('returns an empty list on an empty database', async () => {
    const { app } = await testServer()

    const response = await app.inject({ method: 'GET', url: '/api/projects' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ projects: [] })
  })

  it('reports the derived next action and that the project is not stalled', async () => {
    const { app, database } = await testServer()
    const created = (
      await app.inject({ method: 'POST', url: '/api/projects', payload: { title: 'Ship it' } })
    ).json()
    const task = createTask(
      database,
      { title: 'Do the thing', status: 'next_action', projectId: created.id },
      earlier,
    )

    const body = (await app.inject({ method: 'GET', url: '/api/projects' })).json()

    expect(body.projects).toHaveLength(1)
    expect(body.projects[0].nextAction).toMatchObject({ id: task.id, title: 'Do the thing' })
    expect(body.projects[0].stalled).toBe(false)
  })

  it('flags an active project with nothing to do next as stalled', async () => {
    const { app } = await testServer()
    await app.inject({ method: 'POST', url: '/api/projects', payload: { title: 'Ship it' } })

    const body = (await app.inject({ method: 'GET', url: '/api/projects' })).json()

    expect(body.projects[0]).toMatchObject({ nextAction: null, stalled: true })
  })

  it('does not flag a someday project as stalled', async () => {
    const { app } = await testServer()
    await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { title: 'One day', state: 'someday' },
    })

    const body = (await app.inject({ method: 'GET', url: '/api/projects' })).json()

    expect(body.projects[0].stalled).toBe(false)
  })

  it('filters by state', async () => {
    const { app } = await testServer()
    await app.inject({ method: 'POST', url: '/api/projects', payload: { title: 'Active one' } })
    await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { title: 'Dropped one', state: 'dropped' },
    })

    const body = (await app.inject({ method: 'GET', url: '/api/projects?state=dropped' })).json()

    expect(body.projects.map((project: { title: string }) => project.title)).toEqual([
      'Dropped one',
    ])
  })

  it('rejects an unknown state', async () => {
    const { app } = await testServer()

    const response = await app.inject({ method: 'GET', url: '/api/projects?state=procrastinating' })

    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('bad_request')
  })
})

describe('POST /api/projects', () => {
  it('creates an active project stamped with the request time', async () => {
    const { app, database } = await testServer()

    const response = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { title: 'Ship it', notes: 'By March' },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({
      title: 'Ship it',
      notes: 'By March',
      state: 'active',
      createdAt: REQUEST_TIME,
      completedAt: null,
      nextAction: null,
      stalled: true,
    })
    expect(listProjects(database)).toHaveLength(1)
  })

  it('announces the change on the feed', async () => {
    const { app, published } = await testServer()

    await app.inject({ method: 'POST', url: '/api/projects', payload: { title: 'Ship it' } })

    expect(published).toEqual([{ kind: 'projects', at: REQUEST_TIME }])
  })

  it('rejects a missing title', async () => {
    const { app } = await testServer()

    const response = await app.inject({ method: 'POST', url: '/api/projects', payload: {} })

    expect(response.statusCode).toBe(400)
  })
})

describe('GET /api/projects/:id', () => {
  it('returns the project with its derived fields', async () => {
    const { app } = await testServer()
    const created = (
      await app.inject({ method: 'POST', url: '/api/projects', payload: { title: 'Ship it' } })
    ).json()

    const body = (await app.inject({ method: 'GET', url: `/api/projects/${created.id}` })).json()

    expect(body).toMatchObject({ id: created.id, title: 'Ship it', stalled: true })
  })

  it('answers 404 for a project that does not exist', async () => {
    const { app } = await testServer()

    const response = await app.inject({ method: 'GET', url: '/api/projects/no-such-project' })

    expect(response.statusCode).toBe(404)
    expect(response.json().error.code).toBe('not_found')
  })
})

describe('PATCH /api/projects/:id', () => {
  it('updates the title and notes', async () => {
    const { app } = await testServer()
    const created = (
      await app.inject({ method: 'POST', url: '/api/projects', payload: { title: 'Ship it' } })
    ).json()

    const body = (
      await app.inject({
        method: 'PATCH',
        url: `/api/projects/${created.id}`,
        payload: { title: 'Ship it properly', notes: null },
      })
    ).json()

    expect(body).toMatchObject({ title: 'Ship it properly', notes: null, updatedAt: REQUEST_TIME })
  })

  it('stamps a completion when the project is marked done', async () => {
    const { app } = await testServer()
    const created = (
      await app.inject({ method: 'POST', url: '/api/projects', payload: { title: 'Ship it' } })
    ).json()

    const body = (
      await app.inject({
        method: 'PATCH',
        url: `/api/projects/${created.id}`,
        payload: { state: 'done' },
      })
    ).json()

    expect(body).toMatchObject({ state: 'done', completedAt: REQUEST_TIME })
  })

  it('announces the change on the feed', async () => {
    const { app, published } = await testServer()
    const created = (
      await app.inject({ method: 'POST', url: '/api/projects', payload: { title: 'Ship it' } })
    ).json()
    published.length = 0

    await app.inject({
      method: 'PATCH',
      url: `/api/projects/${created.id}`,
      payload: { title: 'Ship it properly' },
    })

    expect(published).toEqual([{ kind: 'projects', at: REQUEST_TIME }])
  })

  it('answers 404 for a project that does not exist', async () => {
    const { app } = await testServer()

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/projects/no-such-project',
      payload: { title: 'Anything' },
    })

    expect(response.statusCode).toBe(404)
  })

  it('rejects an empty patch', async () => {
    const { app } = await testServer()
    const created = (
      await app.inject({ method: 'POST', url: '/api/projects', payload: { title: 'Ship it' } })
    ).json()

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${created.id}`,
      payload: {},
    })

    expect(response.statusCode).toBe(400)
  })
})

describe('DELETE /api/projects/:id', () => {
  /** Spec 01 criterion 6: the outcome was abandoned, the work was not. */
  it('deletes the project and orphans its tasks rather than deleting them', async () => {
    const { app, database } = await testServer()
    const created = (
      await app.inject({ method: 'POST', url: '/api/projects', payload: { title: 'Ship it' } })
    ).json()
    const task = createTask(database, { title: 'Do the thing', projectId: created.id }, earlier)

    const response = await app.inject({ method: 'DELETE', url: `/api/projects/${created.id}` })

    expect(response.statusCode).toBe(204)
    expect(getProject(database, created.id)).toBeNull()
    expect(getTask(database, task.id)).toMatchObject({ id: task.id, projectId: null })
  })

  it('announces both kinds of change, because tasks moved too', async () => {
    const { app, published } = await testServer()
    const created = (
      await app.inject({ method: 'POST', url: '/api/projects', payload: { title: 'Ship it' } })
    ).json()
    published.length = 0

    await app.inject({ method: 'DELETE', url: `/api/projects/${created.id}` })

    expect(published.map((event) => event.kind)).toEqual(['projects', 'tasks'])
  })

  it('answers 404 for a project that does not exist', async () => {
    const { app } = await testServer()

    const response = await app.inject({ method: 'DELETE', url: '/api/projects/no-such-project' })

    expect(response.statusCode).toBe(404)
  })
})

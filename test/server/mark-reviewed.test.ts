/**
 * `POST /api/tasks/:id/mark-reviewed`: discharging your part of a review from Caroline.
 * Spec 02, criterion 10, and spec 08's Review card action.
 */
import { describe, expect, it } from 'vitest'
import type { Database } from '../../src/db/connection.js'
import { getSourceByExternalId, upsertSource } from '../../src/db/repositories/sources.js'
import { changeTaskStatus, createTask, getTask } from '../../src/db/repositories/tasks.js'
import { REQUEST_TIME, testServer } from '../helpers/test-server.js'

const EXTERNAL_ID = 'example-org/example-service#42'
const HEAD_SHA = '1111111111111111111111111111111111111111'
const SYNCED_AT = REQUEST_TIME - 3_600_000

/** A pull request as sync would have left it: task in Review, source knowing the head sha. */
function trackedPullRequest(database: Database, overrides: { headSha?: string } = {}) {
  const task = createTask(
    database,
    {
      title: 'example-org/example-service#42 Add a retry to the fetch helper',
      status: 'review',
      statusSetBy: 'sync',
      estimateMinutes: 30,
    },
    SYNCED_AT,
  )

  upsertSource(
    database,
    {
      provider: 'github',
      externalId: EXTERNAL_ID,
      url: 'https://github.com/example-org/example-service/pull/42',
      title: 'example-org/example-service#42 Add a retry to the fetch helper',
      metadata: {
        repository: 'example-org/example-service',
        number: 42,
        author: 'author-one',
        headSha: overrides.headSha ?? HEAD_SHA,
      },
      taskId: task.id,
      lifecycleState: 'awaiting_review',
    },
    SYNCED_AT,
  )

  return task
}

describe('marking a pull request reviewed', () => {
  it('moves it to waiting on the author and stamps the marker', async () => {
    const { app, database } = await testServer()
    const task = trackedPullRequest(database)

    const response = await app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/mark-reviewed`,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      status: 'waiting',
      waitingOn: 'author-one',
      completedAt: null,
    })
    expect(getSourceByExternalId(database, 'github', EXTERNAL_ID)).toMatchObject({
      lifecycleState: 'reviewed',
      actedAt: REQUEST_TIME,
      actedAtMarker: HEAD_SHA,
    })
  })

  it('leaves the task tracked, since it is a move inside the connector s own statuses', async () => {
    const { app, database } = await testServer()
    const task = trackedPullRequest(database)

    await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/mark-reviewed` })

    expect(getTask(database, task.id)).toMatchObject({ syncTracked: true, statusSetBy: 'sync' })
  })

  it('returns the source alongside the task, so the card can show where it came from', async () => {
    const { app, database } = await testServer()
    const task = trackedPullRequest(database)

    const body = (
      await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/mark-reviewed` })
    ).json()

    expect(body.sources).toMatchObject([
      {
        provider: 'github',
        externalId: EXTERNAL_ID,
        url: 'https://github.com/example-org/example-service/pull/42',
        lifecycleState: 'reviewed',
        metadata: { author: 'author-one', headSha: HEAD_SHA },
      },
    ])
  })

  it('announces the change so an open board updates without a refresh', async () => {
    const { app, database, published } = await testServer()
    const task = trackedPullRequest(database)

    await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/mark-reviewed` })

    expect(published).toContainEqual({ kind: 'tasks', at: REQUEST_TIME })
  })
})

describe('marking something else reviewed', () => {
  it('is a 404 for a task that does not exist', async () => {
    const { app } = await testServer()

    const response = await app.inject({ method: 'POST', url: '/api/tasks/nope/mark-reviewed' })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({ error: { code: 'not_found' } })
  })

  it('is a 400 for a task with no pull request behind it', async () => {
    const { app, database } = await testServer()
    const task = createTask(database, { title: 'Renew the domain' }, SYNCED_AT)

    const response = await app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/mark-reviewed`,
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error.message).toMatch(/pull request/i)
  })

  it('is a 400 for a task that has opted out of sync tracking', async () => {
    const { app, database } = await testServer()
    const task = trackedPullRequest(database)
    changeTaskStatus(database, task.id, {
      status: 'someday',
      by: 'user',
      at: SYNCED_AT,
      trackedStatuses: ['review', 'waiting', 'done'],
    })

    const response = await app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/mark-reviewed`,
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error.message).toMatch(/tracking/i)
  })
})

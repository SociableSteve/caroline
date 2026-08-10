/**
 * Spec 09, criterion 9: the settings screen can show the exact payload that would be sent for a
 * given real item under the current policy. The payload is built by the same function the
 * classifier calls, which is what makes the preview a preview rather than a second description.
 */
import { describe, expect, it } from 'vitest'
import { upsertSource } from '../../src/db/repositories/sources.js'
import { createTask } from '../../src/db/repositories/tasks.js'
import type { Database } from '../../src/db/connection.js'
import { migratedDatabase } from '../helpers/temp-database.js'
import { REQUEST_TIME, testServer } from '../helpers/test-server.js'

const DAY = 24 * 60 * 60_000

function anIngestedThread(database: Database, content: string | null): string {
  const task = createTask(
    database,
    { title: 'Hub numbers before Thursday', status: 'inbox', statusSetBy: 'sync' },
    REQUEST_TIME - 2 * DAY,
  )

  upsertSource(
    database,
    {
      provider: 'gmail',
      externalId: 'thread-hub-numbers',
      title: 'Hub numbers before Thursday',
      metadata: {
        from: 'Sam Reed <sam.reed@example.com>',
        participants: ['Sam Reed <sam.reed@example.com>', 'you@example.com'],
        labels: ['INBOX'],
        messageCount: 2,
        threadId: 'thread-hub-numbers',
      },
      ...(content === null ? {} : { content, contentLevel: 'full' as const }),
      taskId: task.id,
    },
    REQUEST_TIME - 2 * DAY,
  )

  return task.id
}

describe('GET /api/privacy/preview', () => {
  it('states the policy and what each level means in plain language', async () => {
    const { app } = await testServer()

    const response = await app.inject({ method: 'GET', url: '/api/privacy/preview' })

    expect(response.statusCode).toBe(200)
    expect(response.json().policy).toMatchObject({
      llmContent: 'snippet',
      storeContent: 'metadata',
      snippetChars: 300,
      llmConsequence: expect.stringContaining('leaves this machine'),
      storeConsequence: expect.stringContaining('No message body is kept on disk'),
    })
  })

  it('has no item to show on an empty inbox, and says so rather than failing', async () => {
    const { app } = await testServer()

    const body = (await app.inject({ method: 'GET', url: '/api/privacy/preview' })).json()

    expect(body).toMatchObject({ item: null, payload: null })
  })

  it('shows the payload for the item the classifier would take next', async () => {
    const database = migratedDatabase()
    const taskId = anIngestedThread(database, 'Could you take a look at the hub numbers?')
    const { app } = await testServer({ database })

    const body = (await app.inject({ method: 'GET', url: '/api/privacy/preview' })).json()

    expect(body.item).toEqual({
      taskId,
      title: 'Hub numbers before Thursday',
      provider: 'gmail',
    })
    expect(body.payload).toEqual({
      taskId,
      source: 'gmail',
      ageDays: 2,
      title: 'Hub numbers before Thursday',
      from: 'Sam Reed <sam.reed@example.com>',
      participants: ['Sam Reed <sam.reed@example.com>', 'you@example.com'],
      labels: ['INBOX'],
      messageCount: 2,
      snippet: 'Could you take a look at the hub numbers?',
    })
    expect(body.promptVersion).toMatch(/\d{4}-\d{2}-\d{2}/)
  })

  it('shows a named item when asked for one', async () => {
    const database = migratedDatabase()
    const taskId = anIngestedThread(database, null)
    const { app } = await testServer({ database })

    const body = (
      await app.inject({ method: 'GET', url: `/api/privacy/preview?taskId=${taskId}` })
    ).json()

    expect(body.item).toMatchObject({ taskId })
  })

  it('is a 404 for a task that does not exist', async () => {
    const { app } = await testServer()

    const response = await app.inject({ method: 'GET', url: '/api/privacy/preview?taskId=nope' })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({ error: { code: 'not_found' } })
  })

  it('rejects a query it does not recognise rather than ignoring it', async () => {
    const { app } = await testServer()

    const response = await app.inject({ method: 'GET', url: '/api/privacy/preview?task=nope' })

    expect(response.statusCode).toBe(400)
  })
})

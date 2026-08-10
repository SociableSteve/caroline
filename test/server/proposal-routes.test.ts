/**
 * The one-click accept spec 04 criterion 3 asks the UI to offer, and criterion 9's rule about who
 * the resulting status belongs to.
 */
import { describe, expect, it } from 'vitest'
import type { Database } from '../../src/db/connection.js'
import { recordClassification } from '../../src/db/repositories/classifications.js'
import { upsertSource } from '../../src/db/repositories/sources.js'
import { createTask, getTask } from '../../src/db/repositories/tasks.js'
import { migratedDatabase } from '../helpers/temp-database.js'
import { REQUEST_TIME, testServer } from '../helpers/test-server.js'

interface ProposalOptions {
  readonly status?: 'next_action' | 'waiting' | 'reference'
  readonly suggestedTitle?: string | null
  readonly estimateMinutes?: number | null
  readonly waitingOn?: string | null
  readonly title?: string
}

/** An inbox task with a below-threshold proposal attached, as a classification run leaves it. */
function aProposedTask(database: Database, options: ProposalOptions = {}): string {
  const title = options.title ?? 'Hub numbers before Thursday'
  const task = createTask(
    database,
    { title, status: 'inbox', statusSetBy: 'sync' },
    REQUEST_TIME - 60_000,
  )

  upsertSource(
    database,
    {
      provider: 'gmail',
      externalId: `thread-${task.id}`,
      title,
      taskId: task.id,
    },
    REQUEST_TIME - 60_000,
  )

  recordClassification(
    database,
    {
      taskId: task.id,
      proposedStatus: options.status ?? 'next_action',
      confidence: 0.4,
      reasoning: 'It reads like one action but I am not sure whose.',
      suggestedTitle: options.suggestedTitle ?? null,
      estimateMinutes: options.estimateMinutes ?? null,
      waitingOn: options.waitingOn ?? null,
      provider: 'ollama',
      model: 'a-model',
      promptVersion: '2026-08-10',
      applied: false,
    },
    REQUEST_TIME - 30_000,
  )

  return task.id
}

describe('a task carrying a proposal', () => {
  it('returns it with the task, so the card can offer the accept', async () => {
    const database = migratedDatabase()
    aProposedTask(database)
    const { app } = await testServer({ database })

    const { tasks } = (await app.inject({ method: 'GET', url: '/api/tasks' })).json()

    expect(tasks[0].proposal).toMatchObject({
      status: 'next_action',
      confidence: 0.4,
      reasoning: 'It reads like one action but I am not sure whose.',
      model: 'a-model',
      promptVersion: '2026-08-10',
    })
  })

  it('has none once the user has filed it themselves', async () => {
    const database = migratedDatabase()
    const taskId = aProposedTask(database)
    const { app } = await testServer({ database })

    await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${taskId}`,
      payload: { status: 'someday' },
    })

    const { tasks } = (await app.inject({ method: 'GET', url: '/api/tasks' })).json()
    expect(tasks[0].proposal).toBeNull()
  })
})

describe('POST /api/tasks/:id/proposal/accept', () => {
  /** Spec 04, criterion 9. */
  it('applies the status and attributes it to the user', async () => {
    const database = migratedDatabase()
    const taskId = aProposedTask(database)
    const { app } = await testServer({ database })

    const response = await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/proposal/accept`,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      status: 'next_action',
      statusSetBy: 'user',
      proposal: null,
    })
    expect(getTask(database, taskId)).toMatchObject({ status: 'next_action', statusSetBy: 'user' })
  })

  it('applies the suggested title and keeps the original in the notes', async () => {
    const database = migratedDatabase()
    const taskId = aProposedTask(database, { suggestedTitle: 'Send Sam the hub numbers' })
    const { app } = await testServer({ database })

    await app.inject({ method: 'POST', url: `/api/tasks/${taskId}/proposal/accept` })

    expect(getTask(database, taskId)).toMatchObject({
      title: 'Send Sam the hub numbers',
      notes: 'Original title: Hub numbers before Thursday',
    })
  })

  it('names who a waiting task is waiting on', async () => {
    const database = migratedDatabase()
    const taskId = aProposedTask(database, { status: 'waiting', waitingOn: 'Sam' })
    const { app } = await testServer({ database })

    await app.inject({ method: 'POST', url: `/api/tasks/${taskId}/proposal/accept` })

    expect(getTask(database, taskId)).toMatchObject({ status: 'waiting', waitingOn: 'Sam' })
  })

  it('seeds the estimate the model guessed', async () => {
    const database = migratedDatabase()
    const taskId = aProposedTask(database, { estimateMinutes: 15 })
    const { app } = await testServer({ database })

    await app.inject({ method: 'POST', url: `/api/tasks/${taskId}/proposal/accept` })

    expect(getTask(database, taskId)?.estimateMinutes).toBe(15)
  })

  /**
   * Accepting is the user deciding where the task goes, so it carries the same permanent opt-out
   * every other user status change does: a pull request filed outside Review, Waiting for and Done
   * stops being followed. Spec 01, sync tracking.
   */
  it('turns sync tracking off when the status is outside the connector’s set', async () => {
    const database = migratedDatabase()
    const task = createTask(
      database,
      { title: 'example-org/service#42 Add a retry', status: 'review', statusSetBy: 'sync' },
      REQUEST_TIME - 60_000,
    )
    upsertSource(
      database,
      {
        provider: 'github',
        externalId: 'example-org/service#42',
        title: 'example-org/service#42 Add a retry',
        taskId: task.id,
      },
      REQUEST_TIME - 60_000,
    )
    // A proposal on a tracked pull request task, as a run that could not apply it would leave one.
    database
      .prepare(
        `insert into classifications (id, task_id, proposed_status, confidence, prompt_version,
           applied, created_at)
         values ('classification-9', ?, 'someday', 0.4, '2026-08-10', 0, ?)`,
      )
      .run(task.id, REQUEST_TIME - 30_000)
    database.prepare("update tasks set status = 'inbox' where id = ?").run(task.id)

    const { app } = await testServer({ database })

    await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/proposal/accept` })

    expect(getTask(database, task.id)).toMatchObject({
      status: 'someday',
      statusSetBy: 'user',
      syncTracked: false,
    })
  })

  it('cannot be accepted twice', async () => {
    const database = migratedDatabase()
    const taskId = aProposedTask(database)
    const { app } = await testServer({ database })

    await app.inject({ method: 'POST', url: `/api/tasks/${taskId}/proposal/accept` })
    const second = await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/proposal/accept`,
    })

    expect(second.statusCode).toBe(400)
    expect(second.json()).toMatchObject({ error: { code: 'bad_request' } })
  })

  it('is a 400 on a task with nothing waiting on it', async () => {
    const database = migratedDatabase()
    const task = createTask(database, { title: 'Typed in by hand' }, REQUEST_TIME)
    const { app } = await testServer({ database })

    const response = await app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/proposal/accept`,
    })

    expect(response.statusCode).toBe(400)
  })

  it('is a 404 for a task that does not exist', async () => {
    const { app } = await testServer()

    const response = await app.inject({ method: 'POST', url: '/api/tasks/nope/proposal/accept' })

    expect(response.statusCode).toBe(404)
  })

  it('announces the change so the board reloads', async () => {
    const database = migratedDatabase()
    const taskId = aProposedTask(database)
    const { app, published } = await testServer({ database })

    await app.inject({ method: 'POST', url: `/api/tasks/${taskId}/proposal/accept` })

    expect(published.map((event) => event.kind)).toEqual(['tasks', 'projects'])
  })
})

describe('POST /api/tasks/:id/proposal/dismiss', () => {
  it('leaves the task exactly where it is and takes the proposal off the card', async () => {
    const database = migratedDatabase()
    const taskId = aProposedTask(database)
    const { app } = await testServer({ database })

    const response = await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/proposal/dismiss`,
    })

    expect(response.json()).toMatchObject({
      status: 'inbox',
      statusSetBy: 'sync',
      proposal: null,
    })
  })

  it('is a 400 once there is nothing left to dismiss', async () => {
    const database = migratedDatabase()
    const taskId = aProposedTask(database)
    const { app } = await testServer({ database })

    await app.inject({ method: 'POST', url: `/api/tasks/${taskId}/proposal/dismiss` })
    const second = await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/proposal/dismiss`,
    })

    expect(second.statusCode).toBe(400)
  })
})

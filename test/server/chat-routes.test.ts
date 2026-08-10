/**
 * Chat over HTTP. Spec 08's route table and criterion 7: the turn streams incrementally and a
 * dropped connection leaves the conversation recoverable on reload.
 *
 * The streamed route needs a real socket: the response never ends while the turn is running, so
 * `inject` would wait for a payload that is not coming. The others are driven with `inject` as the
 * rest of the API tests are.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../../src/server/app.js'
import { buildJobs, type CarolineJobs } from '../../src/jobs/registry.js'
import { createChangeFeed } from '../../src/server/changes.js'
import { createFakeProvider, type FakeAnswer } from '../../src/llm/fake.js'
import type { LlmProvider } from '../../src/llm/index.js'
import { createTask, getTask } from '../../src/db/repositories/tasks.js'
import type { Database } from '../../src/db/connection.js'
import { migratedDatabase } from '../helpers/temp-database.js'
import { REQUEST_TIME, testConfig } from '../helpers/test-server.js'
import { textAnswer, toolAnswer } from '../helpers/chat.js'

interface ChatServerOptions {
  readonly answers?: readonly FakeAnswer[]
  readonly supportsTools?: boolean
  readonly configured?: boolean
  readonly database?: Database
}

const started: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const stop of started.splice(0)) await stop()
})

/** A real server on a real port, with a provider that answers from a script. */
async function chatServer({
  answers = [textAnswer('Answered.')],
  supportsTools = true,
  configured = true,
  database = migratedDatabase(),
}: ChatServerOptions = {}) {
  const changes = createChangeFeed()
  const provider = createFakeProvider({ answers, supportsTools })
  const built = buildJobs({
    database,
    config: testConfig,
    changes,
    now: () => REQUEST_TIME,
    fetch: () => {
      throw new Error('a test tried to reach the network')
    },
  })

  const jobs: CarolineJobs = {
    ...built,
    llm: {
      isConfigured: () => configured,
      for: (): LlmProvider => provider,
    },
  }

  const app = await buildServer({
    config: testConfig,
    database,
    changes,
    now: () => REQUEST_TIME,
    jobs,
  })
  started.push(() => app.close())

  return { app, database, provider }
}

async function listening(app: FastifyInstance): Promise<string> {
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  if (address === null || typeof address === 'string') throw new Error('expected a TCP address')

  return `http://127.0.0.1:${address.port}`
}

interface WireEvent {
  readonly name: string
  readonly data: Record<string, unknown>
}

/** Reads a whole event stream to its end and cuts it into events, as the client does. */
function parseStream(body: string): WireEvent[] {
  return body.split('\n\n').flatMap((block) => {
    const name = /^event: (.+)$/m.exec(block)?.[1]
    const data = /^data: (.+)$/m.exec(block)?.[1]
    if (name === undefined || data === undefined) return []

    return [{ name, data: JSON.parse(data) as Record<string, unknown> }]
  })
}

async function turn(
  origin: string,
  body: { conversationId?: string; message: string },
): Promise<{ status: number; events: WireEvent[] }> {
  const response = await fetch(`${origin}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!response.ok) return { status: response.status, events: [] }

  return { status: response.status, events: parseStream(await response.text()) }
}

describe('POST /api/chat', () => {
  it('answers as an event stream and streams the text as it arrives', async () => {
    const { app } = await chatServer({ answers: [textAnswer('Your inbox has three things.')] })
    const origin = await listening(app)

    const { status, events } = await turn(origin, { message: 'What is in my inbox?' })

    expect(status).toBe(200)
    expect(events.filter((event) => event.name === 'text').length).toBeGreaterThan(1)
    expect(
      events
        .filter((event) => event.name === 'text')
        .map((event) => String(event.data.text))
        .join(''),
    ).toBe('Your inbox has three things.')
  })

  it('names the conversation first, so a new one can be attached to at once', async () => {
    const { app } = await chatServer()
    const origin = await listening(app)

    const { events } = await turn(origin, { message: 'Hello' })

    expect(events[0]?.name).toBe('conversation')
    expect(events[0]?.data).toMatchObject({ title: 'Hello' })
    expect(events.at(-1)?.name).toBe('done')
  })

  it('reports a change and a confirmation as they happen', async () => {
    const database = migratedDatabase()
    createTask(database, { id: 'task-1', title: 'Book the venue' }, REQUEST_TIME)
    const { app } = await chatServer({
      database,
      answers: [
        toolAnswer([
          { name: 'complete_task', arguments: { id: 'task-1' }, id: 'c1' },
          { name: 'delete_task', arguments: { id: 'task-1' }, id: 'c2' },
        ]),
        textAnswer('Completed one and asked about the other.'),
      ],
    })
    const origin = await listening(app)

    const { events } = await turn(origin, { message: 'Complete it, then delete it' })

    expect(events.filter((event) => event.name === 'change')).toMatchObject([
      { data: { summary: 'Completed “Book the venue”', undoable: true } },
    ])
    expect(events.filter((event) => event.name === 'confirmation')).toMatchObject([
      { data: { reason: 'delete', affectedCount: 1 } },
    ])
  })

  it('refuses a body with no message in it, in the standard error shape', async () => {
    const { app } = await chatServer()

    const response = await app.inject({ method: 'POST', url: '/api/chat', payload: {} })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: { code: 'bad_request' } })
  })

  it('refuses a message of nothing but spaces', async () => {
    const { app } = await chatServer()

    const response = await app.inject({
      method: 'POST',
      url: '/api/chat',
      payload: { message: '   ' },
    })

    expect(response.statusCode).toBe(400)
  })

  /**
   * Decided before the socket is hijacked, so a bad id gets the standard error shape like every
   * other route rather than a 200 carrying an error event.
   */
  it('is a 404 when the conversation does not exist', async () => {
    const { app } = await chatServer()

    const response = await app.inject({
      method: 'POST',
      url: '/api/chat',
      payload: { conversationId: 'nope', message: 'Hello' },
    })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({ error: { code: 'not_found' } })
  })

  /**
   * Spec 08, criterion 7. The turn is recorded as it happens and finished whether or not anybody is
   * reading, so a browser that went away gets the whole thing back by reloading.
   */
  it('finishes and records the turn even when the client goes away', async () => {
    const { app, database } = await chatServer({ answers: [textAnswer('Answered anyway.')] })
    const origin = await listening(app)

    const controller = new AbortController()
    const response = await fetch(`${origin}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'A question' }),
      signal: controller.signal,
    })
    controller.abort()
    await response.body?.cancel().catch(() => undefined)

    await waitFor(() => {
      const rows = database
        .prepare("select content from chat_messages where role = 'assistant'")
        .all()
      expect(rows).toMatchObject([{ content: 'Answered anyway.' }])
    })
  })
})

describe('GET /api/chat/status', () => {
  it('reports what chat can do', async () => {
    const { app } = await chatServer()

    const response = await app.inject({ method: 'GET', url: '/api/chat/status' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      configured: true,
      readOnly: false,
      maxToolCalls: 25,
      bulkConfirmThreshold: 10,
    })
  })

  /** Criterion 7: the UI is told, rather than finding out when a change does not happen. */
  it('reports read-only when the model cannot use tools', async () => {
    const { app } = await chatServer({ supportsTools: false })

    expect((await app.inject({ method: 'GET', url: '/api/chat/status' })).json()).toMatchObject({
      configured: true,
      readOnly: true,
    })
  })

  it('reports read-only when nothing is configured', async () => {
    const { app } = await chatServer({ configured: false })

    expect((await app.inject({ method: 'GET', url: '/api/chat/status' })).json()).toMatchObject({
      configured: false,
      readOnly: true,
    })
  })
})

describe('the conversation history', () => {
  async function withConversation() {
    const { app, database } = await chatServer({
      answers: [textAnswer('One.'), textAnswer('Two.')],
    })
    const origin = await listening(app)
    const { events } = await turn(origin, { message: 'A question' })
    const conversationId = String(events[0]?.data.id)

    return { app, database, origin, conversationId }
  }

  it('lists the conversations, newest first, with their token usage', async () => {
    const { app } = await withConversation()

    const response = await app.inject({ method: 'GET', url: '/api/chat/conversations' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      conversations: [{ title: 'A question', messageCount: 2, outputTokens: 3 }],
    })
  })

  /** Criterion 8: the transcript is what reopening a conversation shows. */
  it('reads one back with its full transcript', async () => {
    const { app, conversationId } = await withConversation()

    const response = await app.inject({
      method: 'GET',
      url: `/api/chat/conversations/${conversationId}`,
    })

    expect(response.json()).toMatchObject({
      conversation: { id: conversationId },
      messages: [
        { role: 'user', content: 'A question' },
        { role: 'assistant', content: 'One.' },
      ],
    })
  })

  it('is a 404 for a conversation that does not exist', async () => {
    const { app } = await chatServer()

    const response = await app.inject({ method: 'GET', url: '/api/chat/conversations/nope' })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({ error: { code: 'not_found' } })
  })
})

describe('POST /api/chat/confirmations/:id', () => {
  async function withPendingDelete() {
    const database = migratedDatabase()
    createTask(database, { id: 'task-1', title: 'Book the venue' }, REQUEST_TIME)
    const { app } = await chatServer({
      database,
      answers: [
        toolAnswer([{ name: 'delete_task', arguments: { id: 'task-1' } }]),
        textAnswer('Asked you to confirm.'),
      ],
    })
    const origin = await listening(app)
    const { events } = await turn(origin, { message: 'Delete the venue task' })
    const confirmation = events.find((event) => event.name === 'confirmation')

    return { app, database, id: String(confirmation?.data.id) }
  }

  it('carries out the operation and reports the change', async () => {
    const { app, database, id } = await withPendingDelete()

    const response = await app.inject({
      method: 'POST',
      url: `/api/chat/confirmations/${id}`,
      payload: { confirmed: true },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      confirmation: { decision: 'confirmed' },
      changes: [{ summary: 'Deleted “Book the venue”' }],
      failures: [],
    })
    expect(getTask(database, 'task-1')).toBeNull()
  })

  it('does nothing when it is discarded', async () => {
    const { app, database, id } = await withPendingDelete()

    const response = await app.inject({
      method: 'POST',
      url: `/api/chat/confirmations/${id}`,
      payload: { confirmed: false },
    })

    expect(response.json()).toMatchObject({
      confirmation: { decision: 'rejected' },
      changes: [],
    })
    expect(getTask(database, 'task-1')).not.toBeNull()
  })

  it('refuses a second decision with a conflict', async () => {
    const { app, id } = await withPendingDelete()
    await app.inject({
      method: 'POST',
      url: `/api/chat/confirmations/${id}`,
      payload: { confirmed: true },
    })

    const response = await app.inject({
      method: 'POST',
      url: `/api/chat/confirmations/${id}`,
      payload: { confirmed: true },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ error: { code: 'conflict' } })
  })

  it('is a 404 for a confirmation that does not exist', async () => {
    const { app } = await chatServer()

    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/confirmations/nope',
      payload: { confirmed: true },
    })

    expect(response.statusCode).toBe(404)
  })

  it('refuses a body that does not say what was decided', async () => {
    const { app } = await chatServer()

    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/confirmations/anything',
      payload: {},
    })

    expect(response.statusCode).toBe(400)
  })
})

describe('POST /api/chat/conversations/:id/undo', () => {
  async function withChange() {
    const database = migratedDatabase()
    createTask(database, { id: 'task-1', title: 'Book the venue' }, REQUEST_TIME)
    const { app } = await chatServer({
      database,
      answers: [
        toolAnswer([{ name: 'complete_task', arguments: { id: 'task-1' } }]),
        textAnswer('Done.'),
      ],
    })
    const origin = await listening(app)
    const { events } = await turn(origin, { message: 'Complete the venue task' })
    const done = events.find((event) => event.name === 'done')
    const message = done?.data.message as { id: string }

    return { app, database, conversationId: String(events[0]?.data.id), messageId: message.id }
  }

  it('puts back what the turn changed', async () => {
    const { app, database, conversationId, messageId } = await withChange()

    const response = await app.inject({
      method: 'POST',
      url: `/api/chat/conversations/${conversationId}/undo`,
      payload: { messageId },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ changes: [{ undoneAt: REQUEST_TIME }] })
    expect(getTask(database, 'task-1')).toMatchObject({ status: 'inbox' })
  })

  it('refuses a second undo of the same turn', async () => {
    const { app, conversationId, messageId } = await withChange()
    await app.inject({
      method: 'POST',
      url: `/api/chat/conversations/${conversationId}/undo`,
      payload: { messageId },
    })

    const response = await app.inject({
      method: 'POST',
      url: `/api/chat/conversations/${conversationId}/undo`,
      payload: { messageId },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ error: { code: 'conflict' } })
  })

  it('is a 404 for a conversation that does not exist', async () => {
    const { app } = await chatServer()

    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/conversations/nope/undo',
      payload: { messageId: 'whatever' },
    })

    expect(response.statusCode).toBe(404)
  })
})

async function waitFor(assertion: () => void, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      assertion()
      return
    } catch (error) {
      if (Date.now() > deadline) throw error
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
}

import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiFailure, api } from './api.js'

interface StubbedCall {
  url: string
  init: RequestInit | undefined
}

function stubFetch(response: { ok?: boolean; status?: number; body?: unknown }): {
  calls: StubbedCall[]
} {
  const calls: StubbedCall[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return {
        ok: response.ok ?? true,
        status: response.status ?? 200,
        json: async () => response.body,
      } as unknown as Response
    }),
  )
  return { calls }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

/** A stub that serves a task list of any size, one page per request, as the server would. */
function stubTaskPages(total: number): { calls: StubbedCall[] } {
  const calls: StubbedCall[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      const query = new URL(url, 'http://localhost').searchParams
      const offset = Number(query.get('offset') ?? 0)
      const limit = Number(query.get('limit') ?? 500)
      const tasks = Array.from(
        { length: Math.max(0, Math.min(limit, total - offset)) },
        (_, i) => ({
          id: `task-${offset + i}`,
        }),
      )

      return {
        ok: true,
        status: 200,
        json: async () => ({ tasks, total, limit, offset }),
      } as unknown as Response
    }),
  )
  return { calls }
}

describe('listTasks', () => {
  it('asks for every task, deferred ones included, so the board can group them itself', async () => {
    const { calls } = stubFetch({ body: { tasks: [], total: 0, limit: 200, offset: 0 } })

    await api.listTasks()

    expect(calls[0]?.url).toBe('/api/tasks?limit=500&offset=0')
  })

  it('passes a project filter through', async () => {
    const { calls } = stubFetch({ body: { tasks: [], total: 0, limit: 200, offset: 0 } })

    await api.listTasks({ projectId: 'project-1' })

    expect(calls[0]?.url).toBe('/api/tasks?limit=500&offset=0&projectId=project-1')
  })

  it('escapes a filter value rather than pasting it into the query', async () => {
    const { calls } = stubFetch({ body: { tasks: [], total: 0, limit: 200, offset: 0 } })

    await api.listTasks({ search: 'a&b=c' })

    expect(calls[0]?.url).toBe('/api/tasks?limit=500&offset=0&search=a%26b%3Dc')
  })

  it('makes one request when everything fits in a page', async () => {
    const { calls } = stubTaskPages(10)

    const collection = await api.listTasks()

    expect(calls).toHaveLength(1)
    expect(collection.tasks).toHaveLength(10)
    expect(collection.truncated).toBe(false)
  })

  /**
   * Done tasks accumulate for as long as Caroline is used, so one page is not a safe
   * assumption: a single page silently dropped everything past the first 500.
   */
  it('follows the pages when there are more tasks than one page holds', async () => {
    const { calls } = stubTaskPages(1200)

    const collection = await api.listTasks()

    expect(calls.map((call) => call.url)).toEqual([
      '/api/tasks?limit=500&offset=0',
      '/api/tasks?limit=500&offset=500',
      '/api/tasks?limit=500&offset=1000',
    ])
    expect(collection.tasks).toHaveLength(1200)
    expect(collection.total).toBe(1200)
    expect(collection.truncated).toBe(false)
  })

  it('keeps the filter on every page it fetches', async () => {
    const { calls } = stubTaskPages(600)

    await api.listTasks({ projectId: 'project-1' })

    expect(calls[1]?.url).toContain('projectId=project-1')
  })

  it('stops at the ceiling and says the answer is incomplete', async () => {
    stubTaskPages(20_000)

    const collection = await api.listTasks()

    expect(collection.tasks).toHaveLength(5000)
    expect(collection.total).toBe(20_000)
    expect(collection.truncated).toBe(true)
  })

  it('stops on an empty page even when the total disagrees with it', async () => {
    const { calls } = stubFetch({ body: { tasks: [], total: 900, limit: 500, offset: 0 } })

    const collection = await api.listTasks()

    expect(calls).toHaveLength(1)
    expect(collection.tasks).toEqual([])
  })
})

describe('writes', () => {
  it('sends a create as JSON', async () => {
    const { calls } = stubFetch({ status: 201, body: { id: 'task-1' } })

    await api.createTask({ title: 'Renew the domain' })

    expect(calls[0]?.url).toBe('/api/tasks')
    expect(calls[0]?.init).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ title: 'Renew the domain' }),
    })
    expect(new Headers(calls[0]?.init?.headers).get('content-type')).toBe('application/json')
  })

  it('sends a status change as a patch', async () => {
    const { calls } = stubFetch({ body: { id: 'task-1' } })

    await api.patchTask('task-1', { status: 'next_action' })

    expect(calls[0]?.url).toBe('/api/tasks/task-1')
    expect(calls[0]?.init).toMatchObject({ method: 'PATCH' })
  })

  it('escapes an id in a path, so it cannot reach into another route', async () => {
    const { calls } = stubFetch({ status: 204 })

    await api.deleteTask('../projects/project-1')

    expect(calls[0]?.url).toBe('/api/tasks/..%2Fprojects%2Fproject-1')
  })

  it('returns nothing for a 204 rather than trying to parse a body', async () => {
    stubFetch({ status: 204 })

    await expect(api.deleteTask('task-1')).resolves.toBeUndefined()
  })
})

describe('failures', () => {
  it('throws the message the API gave, so the UI can show what was wrong', async () => {
    stubFetch({
      ok: false,
      status: 400,
      body: { error: { code: 'bad_request', message: 'No such project' } },
    })

    await expect(api.createTask({ title: 'x' })).rejects.toThrow('No such project')
  })

  it('carries the code, for a caller that wants to tell 404 from 400', async () => {
    stubFetch({
      ok: false,
      status: 404,
      body: { error: { code: 'not_found', message: 'No such task' } },
    })

    await expect(api.patchTask('task-1', { title: 'x' })).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
    })
  })

  it('still fails usefully when the body is not the standard error shape', async () => {
    stubFetch({ ok: false, status: 502, body: 'gateway went away' })

    const failure = await api.listTasks().catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ApiFailure)
    expect((failure as ApiFailure).status).toBe(502)
  })

  it('reports a network failure as a failure rather than hanging', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network down')
      }),
    )

    await expect(api.listTasks()).rejects.toThrow('network down')
  })
})

/**
 * The streamed turn. `EventSource` cannot post a body, so the stream is read off `fetch` and cut
 * into events here; a chunk boundary in the middle of an event is the case worth proving.
 */
describe('api.streamChat', () => {
  function stubStream(chunks: readonly string[], status = 200): { calls: StubbedCall[] } {
    const calls: StubbedCall[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init })

        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder()
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
            controller.close()
          },
        })

        return {
          ok: status < 400,
          status,
          body,
          json: async () => ({ error: { code: 'bad_request', message: 'no' } }),
        } as unknown as Response
      }),
    )

    return { calls }
  }

  const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`

  it('posts the message and reports each event as it arrives', async () => {
    const { calls } = stubStream([
      event('text', { text: 'Your inbox ' }),
      event('text', { text: 'has three things.' }),
    ])
    const seen: unknown[] = []

    await api.streamChat({ message: 'What is in my inbox?' }, (received) => seen.push(received))

    expect(calls[0]?.url).toBe('/api/chat')
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      message: 'What is in my inbox?',
    })
    expect(seen).toEqual([
      { type: 'text', text: 'Your inbox ' },
      { type: 'text', text: 'has three things.' },
    ])
  })

  it('reassembles an event split across two chunks', async () => {
    stubStream(['event: text\ndata: {"tex', 't":"split"}\n\n'])
    const seen: unknown[] = []

    await api.streamChat({ message: 'Hello' }, (received) => seen.push(received))

    expect(seen).toEqual([{ type: 'text', text: 'split' }])
  })

  it('skips a keep-alive comment, which carries no data', async () => {
    stubStream([': open\n\n', event('done', { message: { id: 'message-1' } })])
    const seen: unknown[] = []

    await api.streamChat({ message: 'Hello' }, (received) => seen.push(received))

    expect(seen).toEqual([{ type: 'done', message: { id: 'message-1' } }])
  })

  it('carries the conversation id when one was given', async () => {
    const { calls } = stubStream([event('done', {})])

    await api.streamChat({ conversationId: 'conversation-1', message: 'More' }, () => {})

    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      conversationId: 'conversation-1',
    })
  })

  it('fails with the standard error when the request is refused before the stream starts', async () => {
    stubStream([], 400)

    await expect(api.streamChat({ message: '   ' }, () => {})).rejects.toMatchObject({
      status: 400,
      code: 'bad_request',
    })
  })
})

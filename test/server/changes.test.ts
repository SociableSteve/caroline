/**
 * The change feed: an in-process fan-out, and the SSE route the UI subscribes to so that a
 * change made anywhere shows up without a refresh. Spec 08, the change feed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createChangeFeed } from '../../src/server/changes.js'
import { loadConfig } from '../../src/config/load.js'
import { buildServer } from '../../src/server/app.js'
import { migratedDatabase } from '../helpers/temp-database.js'

const config = loadConfig({ file: null, env: {} as NodeJS.ProcessEnv })

describe('createChangeFeed', () => {
  it('delivers a published change to every subscriber', () => {
    const feed = createChangeFeed()
    const first = vi.fn()
    const second = vi.fn()
    feed.subscribe(first)
    feed.subscribe(second)

    feed.publish({ kind: 'tasks', at: 1 })

    expect(first).toHaveBeenCalledWith({ kind: 'tasks', at: 1 })
    expect(second).toHaveBeenCalledWith({ kind: 'tasks', at: 1 })
  })

  it('stops delivering once a subscriber unsubscribes', () => {
    const feed = createChangeFeed()
    const listener = vi.fn()
    const unsubscribe = feed.subscribe(listener)

    unsubscribe()
    feed.publish({ kind: 'tasks', at: 1 })

    expect(listener).not.toHaveBeenCalled()
    expect(feed.subscriberCount()).toBe(0)
  })

  it('publishes to nobody without complaint', () => {
    const feed = createChangeFeed()

    expect(() => feed.publish({ kind: 'projects', at: 1 })).not.toThrow()
  })

  /**
   * One browser tab whose socket has gone away must not stop another tab being told. A
   * write to a dead socket throws, and this is the only place that can be handled.
   */
  it('delivers to the remaining subscribers when one of them throws', () => {
    const feed = createChangeFeed()
    const healthy = vi.fn()
    feed.subscribe(() => {
      throw new Error('socket gone')
    })
    feed.subscribe(healthy)

    expect(() => feed.publish({ kind: 'tasks', at: 1 })).not.toThrow()
    expect(healthy).toHaveBeenCalledOnce()
  })

  it('unsubscribes idempotently, so a double close cannot drop someone else', () => {
    const feed = createChangeFeed()
    const listener = vi.fn()
    const unsubscribe = feed.subscribe(listener)
    feed.subscribe(vi.fn())

    unsubscribe()
    unsubscribe()

    expect(feed.subscriberCount()).toBe(1)
  })
})

/**
 * SSE cannot be driven through `inject`: the response never ends, so the injected promise
 * never resolves. These tests use a real socket and read the stream as it arrives.
 */
describe('GET /api/changes', () => {
  const started: Array<() => Promise<void>> = []

  afterEach(async () => {
    for (const stop of started.splice(0)) await stop()
  })

  async function listening() {
    const changes = createChangeFeed()
    const app = await buildServer({ config, database: migratedDatabase(), changes })
    await app.listen({ host: '127.0.0.1', port: 0 })
    started.push(() => app.close())

    const address = app.server.address()
    if (address === null || typeof address === 'string') throw new Error('expected a TCP address')

    return { app, changes, origin: `http://127.0.0.1:${address.port}` }
  }

  it('answers as an event stream', async () => {
    const { origin } = await listening()
    const controller = new AbortController()

    const response = await fetch(`${origin}/api/changes`, { signal: controller.signal })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    controller.abort()
  })

  it('writes a published change to the stream', async () => {
    const { changes, origin } = await listening()
    const controller = new AbortController()
    const response = await fetch(`${origin}/api/changes`, { signal: controller.signal })
    const reader = (response.body ?? never()).pipeThrough(new TextDecoderStream()).getReader()

    // Published only once the subscription is in place, so the test is not a race.
    await waitFor(() => expect(changes.subscriberCount()).toBe(1))
    changes.publish({ kind: 'tasks', at: 1234 })

    const event = await readEvent(reader)
    expect(event).toContain('event: change')
    expect(event).toContain('"kind":"tasks"')
    controller.abort()
  })

  it('drops the subscription when the client goes away', async () => {
    const { changes, origin } = await listening()
    const controller = new AbortController()
    await fetch(`${origin}/api/changes`, { signal: controller.signal })
    await waitFor(() => expect(changes.subscriberCount()).toBe(1))

    controller.abort()

    await waitFor(() => expect(changes.subscriberCount()).toBe(0))
  })
})

function never(): never {
  throw new Error('expected a response body')
}

/** Reads until a chunk carrying a change event arrives, ignoring keep-alive comments. */
async function readEvent(reader: ReadableStreamDefaultReader<string>): Promise<string> {
  let buffered = ''
  for (let reads = 0; reads < 10; reads += 1) {
    const { value, done } = await reader.read()
    if (done) break
    buffered += value ?? ''
    if (buffered.includes('event: change')) return buffered
  }
  throw new Error(`no change event arrived, saw: ${JSON.stringify(buffered)}`)
}

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

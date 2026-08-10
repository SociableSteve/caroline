/**
 * What the adapter tests are driven by: a `fetch` that never reaches the network, serves a
 * recorded payload, and keeps every request so the built payload can be inspected rather
 * than the prompt template. Spec 03 criterion 2 and spec 09 criterion 1 both need that.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { JsonSchema } from '../../src/llm/types.js'

export interface RecordedRequest {
  readonly url: string
  readonly headers: Record<string, string>
  readonly body: Record<string, unknown>
}

export interface StubFetch {
  readonly fetch: typeof globalThis.fetch
  readonly requests: readonly RecordedRequest[]
}

export interface StubReply {
  readonly status?: number
  readonly body?: unknown
  /** Newline-delimited JSON, which is how Ollama streams. Wins over `body` when both are set. */
  readonly lines?: readonly unknown[]
  /**
   * A recorded server-sent event stream, verbatim, which is how both hosted providers
   * stream. Sent with the content type their SDKs insist on. Wins over the other two.
   */
  readonly sse?: string
  /** A body sent verbatim, for asserting what an adapter does with one it cannot parse. */
  readonly raw?: { readonly body: string; readonly contentType: string }
}

/**
 * Replies are consumed in order; the last one is reused once they run out, so "always answer
 * this" is the one-element case rather than a separate mode.
 */
export function stubFetch(replies: readonly StubReply[]): StubFetch {
  const requests: RecordedRequest[] = []
  let served = 0

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value
    })

    requests.push({
      url: String(input),
      headers,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    })

    const reply = replies[Math.min(served, replies.length - 1)] ?? {}
    served += 1

    if (reply.raw !== undefined) {
      return new Response(reply.raw.body, {
        status: reply.status ?? 200,
        headers: { 'content-type': reply.raw.contentType },
      })
    }

    if (reply.sse !== undefined) {
      return new Response(reply.sse, {
        status: reply.status ?? 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }

    const payload =
      reply.lines === undefined
        ? JSON.stringify(reply.body ?? {})
        : reply.lines.map((line) => JSON.stringify(line)).join('\n')

    return new Response(payload, {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  return { fetch, requests }
}

export function recordedPayload(name: string): unknown {
  const path = fileURLToPath(new URL(`../fixtures/llm/${name}.json`, import.meta.url))
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** A recorded event stream, read as text because that is exactly what the SDK parses. */
export function recordedStream(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../fixtures/llm/${name}.sse`, import.meta.url)),
    'utf8',
  )
}

/** The schema all three adapters are asked for, so the answers can be compared. */
export const classificationSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'confidence', 'reason'],
  properties: {
    status: { type: 'string', enum: ['inbox', 'next', 'waiting', 'reference'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    reason: { type: 'string' },
  },
}

/** The object every recorded payload encodes, whichever provider sent it. */
export const expectedClassification = {
  status: 'next',
  confidence: 0.82,
  reason: 'It asks for a decision from you and nobody else is blocking it.',
}

/**
 * A `fetch` over the Google token endpoint that never reaches it. Separate from the LLM stub in
 * `llm.ts` because the token endpoint takes a form body rather than JSON, and a stub that parsed the
 * wrong one would fail for the wrong reason.
 */
export interface RecordedTokenRequest {
  readonly url: string
  /** The form fields, so a test can assert the grant type and the verifier that were sent. */
  readonly fields: Record<string, string>
}

export interface TokenReply {
  readonly status?: number
  readonly body?: unknown
}

export interface TokenStub {
  readonly fetch: typeof globalThis.fetch
  readonly requests: RecordedTokenRequest[]
}

/** Replies are consumed in order; the last one repeats once they run out. */
export function stubTokenEndpoint(replies: readonly TokenReply[]): TokenStub {
  const requests: RecordedTokenRequest[] = []
  let served = 0

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const fields: Record<string, string> = {}
    for (const [key, value] of new URLSearchParams(String(init?.body ?? ''))) {
      fields[key] = value
    }

    requests.push({ url: String(input), fields })

    const reply = replies[Math.min(served, replies.length - 1)] ?? {}
    served += 1

    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  return { fetch, requests }
}

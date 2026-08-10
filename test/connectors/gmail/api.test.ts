/**
 * The Gmail HTTP client itself, over a stubbed `fetch`. Nothing here reaches Google.
 *
 * What matters most is how a refusal is reported: a 403 covers both a quota the scheduler should
 * back off from and a scope it will never be granted, and only one of those is worth waiting for.
 */
import { describe, expect, it } from 'vitest'
import { createGmailApi, GmailApiError } from '../../../src/connectors/gmail/api.js'

interface StubbedReply {
  readonly status?: number
  readonly body?: unknown
}

function stub(replies: readonly StubbedReply[]) {
  const urls: string[] = []
  const headers: Array<Record<string, string>> = []
  let served = 0

  const fetch: typeof globalThis.fetch = async (input, init) => {
    urls.push(String(input))
    const seen: Record<string, string> = {}
    new Headers(init?.headers).forEach((value, key) => {
      seen[key] = value
    })
    headers.push(seen)

    const reply = replies[Math.min(served, replies.length - 1)] ?? {}
    served += 1

    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  return { fetch, urls, headers }
}

function api(replies: readonly StubbedReply[]) {
  const stubbed = stub(replies)
  return {
    ...stubbed,
    gmail: createGmailApi({
      accessToken: () => Promise.resolve('access-1'),
      fetch: stubbed.fetch,
    }),
  }
}

describe('listing threads', () => {
  it('sends the query and the bearer token, and returns the ids', async () => {
    const { gmail, urls, headers } = api([
      { body: { threads: [{ id: 'thread-1' }, { id: 'thread-2' }] } },
    ])

    expect(await gmail.listThreadIds('in:inbox')).toEqual(['thread-1', 'thread-2'])
    expect(urls[0]).toContain('q=in%3Ainbox')
    expect(headers[0]?.authorization).toBe('Bearer access-1')
  })

  it('follows the pages Gmail offers', async () => {
    const { gmail, urls } = api([
      { body: { threads: [{ id: 'thread-1' }], nextPageToken: 'page-2' } },
      { body: { threads: [{ id: 'thread-2' }] } },
    ])

    expect(await gmail.listThreadIds('in:inbox')).toEqual(['thread-1', 'thread-2'])
    expect(urls[1]).toContain('pageToken=page-2')
  })

  /**
   * A partial result set would read as the whole one, and every thread missing from it would look
   * like one handled in Gmail, which would retire its task. Failing loudly is the safe answer.
   */
  it('fails rather than truncating when the pages do not run out', async () => {
    const { gmail } = api([{ body: { threads: [{ id: 'thread-1' }], nextPageToken: 'more' } }])

    await expect(gmail.listThreadIds('in:inbox')).rejects.toThrow(/still had pages/)
  })
})

describe('a refused request', () => {
  it('reads a quota refusal as one to wait out', async () => {
    const { gmail } = api([
      {
        status: 403,
        body: {
          error: {
            message: 'User-rate limit exceeded.',
            errors: [{ reason: 'userRateLimitExceeded' }],
          },
        },
      },
    ])

    await expect(gmail.listThreadIds('in:inbox')).rejects.toThrow(/rate limit reached.*try again/is)
  })

  it('reads a 429 as a rate limit whatever the body says', async () => {
    const { gmail } = api([{ status: 429, body: {} }])

    await expect(gmail.listThreadIds('in:inbox')).rejects.toThrow(/rate limit reached/i)
  })

  /**
   * The trap this splits: a missing scope is permanent, so backing off from it retries forever and
   * never succeeds. The run history should say what would actually fix it.
   */
  it('reads a permission refusal as one to reconnect for', async () => {
    const { gmail } = api([
      {
        status: 403,
        body: {
          error: {
            message: 'Request had insufficient authentication scopes.',
            errors: [{ reason: 'insufficientPermissions' }],
          },
        },
      },
    ])

    const failure = await gmail.listThreadIds('in:inbox').catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(GmailApiError)
    expect((failure as Error).message).toMatch(/reconnect the Google account/i)
    expect((failure as Error).message).not.toMatch(/rate limit/i)
  })

  it('says to reconnect when the token itself is rejected', async () => {
    const { gmail } = api([{ status: 401, body: {} }])

    await expect(gmail.listThreadIds('in:inbox')).rejects.toThrow(/Reconnect the Google account/)
  })
})

describe('fetching a thread', () => {
  it('asks for the format it was given', async () => {
    const { gmail, urls } = api([{ body: { id: 'thread-1', messages: [] } }])

    await gmail.getThread('thread-1', 'metadata')

    expect(urls[0]).toContain('format=metadata')
  })

  it('fails when Gmail answers with something that is not a thread', async () => {
    const { gmail } = api([{ body: {} }])

    await expect(gmail.getThread('thread-1', 'full')).rejects.toThrow(/no thread for thread-1/)
  })
})

/**
 * The GraphQL client, against a stubbed `fetch`. Nothing here reaches the network: the
 * request it builds is the thing under test, and the responses are the recorded payloads.
 * Spec 02, criterion 8.
 */
import { describe, expect, it } from 'vitest'
import {
  createGitHubApi,
  DISCOVERY_QUERY,
  GitHubApiError,
  refreshQuery,
  refreshVariables,
  REFRESH_BATCH,
} from '../../../src/connectors/github/api.js'
import { discoveryFixture, refreshFixture, VIEWER } from '../../helpers/github.js'

interface StubbedCall {
  readonly query: string
  readonly variables: Record<string, unknown>
  readonly headers: Record<string, string>
}

function stubFetch(
  answer: (call: StubbedCall) => {
    body?: unknown
    status?: number
    headers?: Record<string, string>
  },
) {
  const calls: StubbedCall[] = []

  const fetch = (async (_url: string | URL, init?: RequestInit) => {
    const parsed = JSON.parse(String(init?.body)) as {
      query: string
      variables: Record<string, unknown>
    }
    const call = {
      query: parsed.query,
      variables: parsed.variables,
      headers: init?.headers as Record<string, string>,
    }
    calls.push(call)

    const { body = {}, status = 200, headers = {} } = answer(call)
    return {
      ok: status < 400,
      status,
      statusText: status === 200 ? 'OK' : 'Failed',
      headers: new Headers(headers),
      json: async () => body,
    } as unknown as Response
  }) as typeof globalThis.fetch

  return { fetch, calls }
}

function apiAnswering(
  answer: (call: StubbedCall) => {
    body?: unknown
    status?: number
    headers?: Record<string, string>
  },
) {
  const { fetch, calls } = stubFetch(answer)
  return { api: createGitHubApi({ token: 'ghp_not_a_real_token', fetch }), calls }
}

describe('the client', () => {
  it('authenticates with the token as a bearer', async () => {
    const { api, calls } = apiAnswering(() => ({ body: { data: { viewer: { login: VIEWER } } } }))

    await api.viewerLogin()

    expect(calls[0]?.headers.authorization).toBe('bearer ghp_not_a_real_token')
  })

  it('asks for open pull requests requesting your review, archived repositories excluded', async () => {
    const { api, calls } = apiAnswering(() => ({
      body: { data: { search: { nodes: discoveryFixture() } } },
    }))

    const nodes = await api.searchReviewRequested(VIEWER)

    expect(calls[0]?.variables).toMatchObject({ q: DISCOVERY_QUERY, viewer: VIEWER })
    expect(DISCOVERY_QUERY).toContain('review-requested:@me')
    expect(nodes).toHaveLength(2)
  })

  it('ignores a search result that is not a pull request', async () => {
    const { api } = apiAnswering(() => ({
      // The type condition in the document leaves an issue behind as an empty object.
      body: { data: { search: { nodes: [{}, ...discoveryFixture()] } } },
    }))

    expect(await api.searchReviewRequested(VIEWER)).toHaveLength(2)
  })

  it('follows several pull requests in one request rather than one each', async () => {
    const { api, calls } = apiAnswering(() => ({ body: refreshFixture('refresh-merged') }))

    await api.pullRequests(VIEWER, [
      { owner: 'example-org', name: 'example-service', number: 42 },
      { owner: 'example-org', name: 'example-web', number: 7 },
    ])

    expect(calls).toHaveLength(1)
    expect(calls[0]?.variables).toMatchObject({
      viewer: VIEWER,
      owner0: 'example-org',
      name0: 'example-service',
      number0: 42,
      owner1: 'example-org',
      name1: 'example-web',
      number1: 7,
    })
  })

  it('asks for nothing when there is nothing to follow', async () => {
    const { api, calls } = apiAnswering(() => ({ body: { data: {} } }))

    expect(await api.pullRequests(VIEWER, [])).toEqual([])
    expect(calls).toEqual([])
  })

  it('skips a repository that came back null rather than failing the whole run', async () => {
    // A deleted repository, or one the token has lost access to, answers null rather than
    // erroring. The other pull requests in the batch are still worth having.
    const { api } = apiAnswering(() => ({
      body: { data: { pr0: null, pr1: { pullRequest: refreshFixture('refresh-merged')[0] } } },
    }))

    const nodes = await api.pullRequests(VIEWER, [
      { owner: 'example-org', name: 'gone', number: 1 },
      { owner: 'example-org', name: 'example-service', number: 42 },
    ])

    expect(nodes.map((node) => node.number)).toEqual([42])
  })

  it('follows at most one batch, leaving the rest for the next run', async () => {
    const refs = Array.from({ length: REFRESH_BATCH + 10 }, (_, index) => ({
      owner: 'example-org',
      name: 'example-service',
      number: index + 1,
    }))
    const { api, calls } = apiAnswering(() => ({ body: { data: {} } }))

    await api.pullRequests(VIEWER, refs)

    expect(Object.keys(calls[0]?.variables ?? {})).toHaveLength(REFRESH_BATCH * 3 + 1)
  })
})

describe('a failure', () => {
  it('is reported with the status when the request itself failed', async () => {
    const { api } = apiAnswering(() => ({ status: 500 }))

    await expect(api.viewerLogin()).rejects.toThrow(GitHubApiError)
  })

  it('is reported when GraphQL answered 200 with errors in the body', async () => {
    const { api } = apiAnswering(() => ({
      body: { data: null, errors: [{ message: 'Could not resolve to a Repository' }] },
    }))

    await expect(api.searchReviewRequested(VIEWER)).rejects.toThrow(
      /Could not resolve to a Repository/,
    )
  })

  it('is reported when the token does not say who it belongs to', async () => {
    const { api } = apiAnswering(() => ({ body: { data: { viewer: null } } }))

    await expect(api.viewerLogin()).rejects.toThrow(/who the token belongs to/)
  })

  /** Rate limiting is handled by respecting GitHub's own headers, not by fixed sleeps. */
  it('names the retry-after when GitHub asks you to wait', async () => {
    const { api } = apiAnswering(() => ({ status: 429, headers: { 'retry-after': '60' } }))

    await expect(api.viewerLogin()).rejects.toThrow(/retry after 60 seconds/)
  })

  it('names the reset time when the hourly limit is spent', async () => {
    const { api } = apiAnswering(() => ({
      status: 403,
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1767610800' },
    }))

    await expect(api.viewerLogin()).rejects.toThrow(/rate limit reached: resets at/)
  })

  it('reports an ordinary 403 as a 403, since not every one is a rate limit', async () => {
    const { api } = apiAnswering(() => ({
      status: 403,
      headers: { 'x-ratelimit-remaining': '48' },
    }))

    await expect(api.viewerLogin()).rejects.toThrow(/GitHub answered 403/)
  })
})

describe('the refresh document', () => {
  it('binds every repository and number as a variable rather than inlining them', () => {
    const refs = [{ owner: 'example-org', name: 'example-service', number: 42 }]

    expect(refreshQuery(refs)).not.toContain('example-org')
    expect(refreshVariables(VIEWER, refs)).toEqual({
      viewer: VIEWER,
      owner0: 'example-org',
      name0: 'example-service',
      number0: 42,
    })
  })
})

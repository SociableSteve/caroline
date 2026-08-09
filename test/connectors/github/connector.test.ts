/**
 * The GitHub connector's two passes, against the recorded payloads in
 * `test/fixtures/github`. No network anywhere: spec 02, criterion 8.
 */
import { describe, expect, it } from 'vitest'
import {
  createGitHubConnector,
  type KnownPullRequest,
} from '../../../src/connectors/github/connector.js'
import type { SourceItem } from '../../../src/connectors/types.js'
import {
  discoveryFixture,
  fakeGitHubApi,
  refreshFixture,
  type FakeGitHubApi,
} from '../../helpers/github.js'

const returnOnCommits = { returnToReviewOnNewCommits: true }

async function collect(
  api: FakeGitHubApi,
  known: readonly KnownPullRequest[] = [],
): Promise<SourceItem[]> {
  const connector = createGitHubConnector({
    api,
    isConfigured: () => true,
    options: returnOnCommits,
    known: () => known,
  })

  const items: SourceItem[] = []
  for await (const item of connector.fetch(null)) items.push(item)

  return items
}

describe('the discovery pass', () => {
  it('turns each requested review into an item in the Review column', async () => {
    const items = await collect(fakeGitHubApi({ discovery: [discoveryFixture()] }))

    expect(items).toHaveLength(2)
    expect(items.map((item) => [item.externalId, item.task?.status])).toEqual([
      ['example-org/example-service#42', 'review'],
      ['example-org/example-web#7', 'review'],
    ])
  })

  it('carries the metadata spec 02 asks be retained, and no body', async () => {
    const [item] = await collect(fakeGitHubApi({ discovery: [discoveryFixture()] }))

    expect(item?.metadata).toEqual({
      repository: 'example-org/example-service',
      number: 42,
      author: 'author-one',
      draft: false,
      additions: 120,
      deletions: 30,
      changedFiles: 6,
      reviewRequestedAt: Date.UTC(2026, 0, 5, 9, 12),
      headSha: '1111111111111111111111111111111111111111',
      headCommittedAt: Date.UTC(2026, 0, 5, 9, 10),
      lastReviewState: null,
      lastReviewAt: null,
    })
    expect(item?.content).toBeUndefined()
  })

  it('titles the card with the repository and number, which is what identifies it', async () => {
    const [item] = await collect(fakeGitHubApi({ discovery: [discoveryFixture()] }))

    expect(item?.title).toBe('example-org/example-service#42 Add a retry to the fetch helper')
    expect(item?.url).toBe('https://github.com/example-org/example-service/pull/42')
  })

  it('seeds an estimate from the pull request size', async () => {
    const items = await collect(fakeGitHubApi({ discovery: [discoveryFixture()] }))

    expect(items.map((item) => item.task?.estimateMinutes)).toEqual([30, 20])
  })

  it('follows a review requested through a team as well as one requested directly', async () => {
    const items = await collect(fakeGitHubApi({ discovery: [discoveryFixture()] }))

    expect(items[1]).toMatchObject({
      externalId: 'example-org/example-web#7',
      lifecycleState: 'awaiting_review',
    })
  })
})

describe('the refresh pass', () => {
  const known: KnownPullRequest[] = [
    {
      externalId: 'example-org/example-service#42',
      state: 'awaiting_review',
      actedAt: null,
      actedAtMarker: null,
    },
  ]

  it('fetches a pull request the discovery query no longer returns', async () => {
    // Submitting a review takes it out of the search results, which is the whole reason the
    // refresh pass exists. Spec 02, criterion 18.
    const api = fakeGitHubApi({
      discovery: [[]],
      refresh: [refreshFixture('refresh-changes-requested')],
    })

    const items = await collect(api, known)

    expect(api.refreshed).toEqual([[{ owner: 'example-org', name: 'example-service', number: 42 }]])
    expect(items).toMatchObject([
      { externalId: 'example-org/example-service#42', lifecycleState: 'reviewed' },
    ])
  })

  it('does not refetch what discovery already returned', async () => {
    const api = fakeGitHubApi({ discovery: [discoveryFixture()] })

    const items = await collect(api, known)

    expect(api.refreshed).toEqual([[]])
    expect(items).toHaveLength(2)
  })

  it('ignores a stored external id it cannot turn back into a pull request', async () => {
    const api = fakeGitHubApi({ discovery: [[]] })

    await collect(api, [
      { externalId: 'not-a-pull-request', state: null, actedAt: null, actedAtMarker: null },
    ])

    expect(api.refreshed).toEqual([[]])
  })
})

describe('a merged pull request', () => {
  it('comes back resolved, with completion left to the engine to propose', async () => {
    const api = fakeGitHubApi({ discovery: [[]], refresh: [refreshFixture('refresh-merged')] })

    const items = await collect(api, [
      {
        externalId: 'example-org/example-service#42',
        state: 'reviewed',
        actedAt: Date.UTC(2026, 0, 8, 16, 30),
        actedAtMarker: '3333333333333333333333333333333333333333',
      },
    ])

    expect(items[0]).toMatchObject({ resolved: true, lifecycleState: 'closed' })
  })
})

describe('the viewer', () => {
  it('is asked for once and reused, since a token does not change owner mid-process', async () => {
    let asked = 0
    const api = fakeGitHubApi({ discovery: [discoveryFixture()] })
    const counting = {
      ...api,
      viewerLogin: async () => {
        asked += 1
        return api.viewerLogin()
      },
    }

    const connector = createGitHubConnector({
      api: counting,
      isConfigured: () => true,
      options: returnOnCommits,
      known: () => [],
    })

    // Drained deliberately: the generator does no work at all until it is iterated.
    let seen = 0
    for (let run = 0; run < 3; run += 1) {
      for await (const item of connector.fetch(null)) seen += item.externalId.length
    }

    expect(seen).toBeGreaterThan(0)

    expect(asked).toBe(1)
  })
})

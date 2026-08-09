/**
 * Reading the recorded GitHub payloads, and a fake `GitHubApi` over them. Nothing in the
 * suite reaches the network: the connector is driven entirely by what is in
 * `test/fixtures/github`. Spec 02, criterion 8.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { GitHubApi, PullRequestNode, PullRequestRef } from '../../src/connectors/github/api.js'

export const VIEWER = 'reviewer-you'

function fixture(name: string): { data: Record<string, unknown> } {
  const path = fileURLToPath(new URL(`../fixtures/github/${name}.json`, import.meta.url))
  return JSON.parse(readFileSync(path, 'utf8')) as { data: Record<string, unknown> }
}

/** The pull requests in a recorded discovery search, in the order GitHub returned them. */
export function discoveryFixture(name = 'discovery'): PullRequestNode[] {
  const search = fixture(name).data.search as { nodes: PullRequestNode[] }
  return search.nodes
}

/** The pull requests in a recorded refresh response, unwrapped from their aliases. */
export function refreshFixture(name: string): PullRequestNode[] {
  const data = fixture(name).data as Record<string, { pullRequest: PullRequestNode }>
  return Object.values(data).map((entry) => entry.pullRequest)
}

export interface FakeGitHubApi extends GitHubApi {
  /** The refs each refresh pass asked for, so a test can assert what it followed. */
  readonly refreshed: PullRequestRef[][]
  readonly searches: number
}

export interface FakeGitHubApiOptions {
  /** What each successive discovery pass returns. The last entry repeats after that. */
  readonly discovery: ReadonlyArray<readonly PullRequestNode[]>
  /** What each successive refresh pass returns, matched only to the refs it was given. */
  readonly refresh?: ReadonlyArray<readonly PullRequestNode[]>
  readonly viewer?: string
}

/**
 * Answers the two passes from canned lists, one per run. A refresh only ever returns the
 * pull requests it was actually asked for, so a test cannot accidentally assert that the
 * refresh pass works while the connector is quietly asking for nothing.
 */
export function fakeGitHubApi({
  discovery,
  refresh = [],
  viewer = VIEWER,
}: FakeGitHubApiOptions): FakeGitHubApi {
  let run = 0
  const refreshed: PullRequestRef[][] = []
  const state = { searches: 0 }

  const at = <T>(lists: ReadonlyArray<readonly T[]>, index: number): readonly T[] =>
    lists.length === 0 ? [] : (lists[Math.min(index, lists.length - 1)] ?? [])

  return {
    get refreshed() {
      return refreshed
    },
    get searches() {
      return state.searches
    },

    async viewerLogin() {
      return viewer
    },

    async searchReviewRequested() {
      const nodes = at(discovery, state.searches)
      state.searches += 1
      return [...nodes]
    },

    async pullRequests(_viewer, refs) {
      refreshed.push([...refs])
      const available = at(refresh, run)
      run += 1

      const wanted = new Set(refs.map((ref) => `${ref.owner}/${ref.name}#${ref.number}`))
      return available.filter((node) =>
        wanted.has(`${node.repository.nameWithOwner}#${node.number}`),
      )
    },
  }
}

export interface PullRequestOverrides {
  readonly number?: number
  readonly repository?: string
  readonly title?: string
  readonly state?: 'OPEN' | 'CLOSED' | 'MERGED'
  readonly author?: string
  readonly headSha?: string
  readonly headCommittedAt?: string
  readonly requestedReviewers?: ReadonlyArray<'you' | 'team'>
  readonly reviewRequestedAt?: string | null
  readonly review?: {
    readonly state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED'
    readonly submittedAt: string
    readonly sha: string
  } | null
  readonly additions?: number
  readonly deletions?: number
  readonly changedFiles?: number
  readonly updatedAt?: string
}

/**
 * A pull request node built from the parts a lifecycle step cares about. The recorded
 * fixtures prove the shape is right; this keeps a table walking twelve transitions readable
 * rather than twelve near-identical files.
 */
export function pullRequestNode(overrides: PullRequestOverrides = {}): PullRequestNode {
  const {
    number = 42,
    repository = 'example-org/example-service',
    title = 'Add a retry to the fetch helper',
    state = 'OPEN',
    author = 'author-one',
    headSha = '1111111111111111111111111111111111111111',
    headCommittedAt = '2026-01-05T09:10:00Z',
    requestedReviewers = ['you'],
    reviewRequestedAt = '2026-01-05T09:12:00Z',
    review = null,
    additions = 120,
    deletions = 30,
    changedFiles = 6,
    updatedAt = '2026-01-05T09:15:00Z',
  } = overrides

  const reviewer = (kind: 'you' | 'team') =>
    kind === 'you'
      ? ({ __typename: 'User', login: VIEWER } as const)
      : ({ __typename: 'Team', slug: 'platform' } as const)

  return {
    number,
    title,
    url: `https://github.com/${repository}/pull/${number}`,
    state,
    isDraft: false,
    additions,
    deletions,
    changedFiles,
    updatedAt,
    author: { login: author },
    repository: { nameWithOwner: repository },
    headRefOid: headSha,
    commits: { nodes: [{ commit: { oid: headSha, committedDate: headCommittedAt } }] },
    reviewRequests: {
      nodes: requestedReviewers.map((kind) => ({ requestedReviewer: reviewer(kind) })),
    },
    reviews: {
      nodes:
        review === null
          ? []
          : [{ state: review.state, submittedAt: review.submittedAt, commit: { oid: review.sha } }],
    },
    timelineItems: {
      nodes:
        reviewRequestedAt === null
          ? []
          : [{ createdAt: reviewRequestedAt, requestedReviewer: reviewer('you') }],
    },
  }
}

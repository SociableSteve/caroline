/**
 * The GitHub side of the connector: the GraphQL documents, the shape of what comes back,
 * and the HTTP client that runs them. Nothing here knows about tasks, sources or the
 * database, which is what lets the connector be driven by recorded fixtures with no network
 * anywhere in the suite. Spec 02, criterion 8.
 */
import type { ReviewSubmissionState } from '../../domain/review.js'

export interface PullRequestRef {
  readonly owner: string
  readonly name: string
  readonly number: number
}

export type RequestedReviewer =
  | { readonly __typename: 'User'; readonly login: string }
  | { readonly __typename: 'Team'; readonly slug: string }
  | null

export interface PullRequestNode {
  readonly number: number
  readonly title: string
  readonly url: string
  readonly state: 'OPEN' | 'CLOSED' | 'MERGED'
  readonly isDraft: boolean
  readonly additions: number
  readonly deletions: number
  readonly changedFiles: number
  readonly updatedAt: string
  readonly author: { readonly login: string } | null
  readonly repository: { readonly nameWithOwner: string }
  readonly headRefOid: string
  readonly commits: {
    readonly nodes: ReadonlyArray<{
      readonly commit: { readonly oid: string; readonly committedDate: string }
    }>
  }
  readonly reviewRequests: {
    readonly nodes: ReadonlyArray<{ readonly requestedReviewer: RequestedReviewer }>
  }
  /** Your reviews only: the query filters by author, so the last node is your latest. */
  readonly reviews: {
    readonly nodes: ReadonlyArray<{
      readonly state: ReviewSubmissionState
      readonly submittedAt: string | null
      readonly commit: { readonly oid: string } | null
    }>
  }
  readonly timelineItems: {
    readonly nodes: ReadonlyArray<{
      readonly createdAt: string
      readonly requestedReviewer: RequestedReviewer
    }>
  }
}

/**
 * What the connector needs from GitHub. An interface rather than a class so the tests can
 * hand it recorded payloads, and so the two passes read as what they are.
 */
export interface GitHubApi {
  /** Who the token belongs to. Cached by the caller: it does not change under a process. */
  viewerLogin(): Promise<string>
  /** The discovery pass: open pull requests currently requesting your review. */
  searchReviewRequested(viewer: string): Promise<PullRequestNode[]>
  /** The refresh pass: named pull requests, fetched whatever a search would say. */
  pullRequests(viewer: string, refs: readonly PullRequestRef[]): Promise<PullRequestNode[]>
}

/**
 * Everything both passes read from a pull request. One fragment, so the discovery and
 * refresh passes cannot drift into seeing different facts about the same item.
 */
const pullRequestFields = `
  number
  title
  url
  state
  isDraft
  additions
  deletions
  changedFiles
  updatedAt
  author { login }
  repository { nameWithOwner }
  headRefOid
  commits(last: 1) { nodes { commit { oid committedDate } } }
  reviewRequests(first: 20) {
    nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug } } }
  }
  reviews(last: 1, author: $viewer) { nodes { state submittedAt commit { oid } } }
  timelineItems(last: 20, itemTypes: [REVIEW_REQUESTED_EVENT]) {
    nodes {
      ... on ReviewRequestedEvent {
        createdAt
        requestedReviewer { __typename ... on User { login } ... on Team { slug } }
      }
    }
  }
`

export const viewerQuery = `query Viewer { viewer { login } }`

/**
 * `review-requested:@me` covers requests made to a team you belong to as well as ones made
 * to you directly, which is exactly the scope spec 02 asks for. `archived:false` keeps
 * requests on repositories nobody can merge into out of the Review column.
 */
export const DISCOVERY_QUERY = 'is:open is:pr archived:false review-requested:@me'

export const discoveryQuery = `
  query Discovery($q: String!, $viewer: String!, $first: Int!) {
    search(query: $q, type: ISSUE, first: $first) {
      nodes { ... on PullRequest { ${pullRequestFields} } }
    }
  }
`

/**
 * One aliased block per pull request, so following a few dozen of them costs one request
 * against the rate limit rather than a few dozen. Spec 02.
 */
export function refreshQuery(refs: readonly PullRequestRef[]): string {
  const parameters = refs
    .map((_, index) => `$owner${index}: String!, $name${index}: String!, $number${index}: Int!`)
    .join(', ')

  const blocks = refs
    .map(
      (_, index) => `
        pr${index}: repository(owner: $owner${index}, name: $name${index}) {
          pullRequest(number: $number${index}) { ${pullRequestFields} }
        }`,
    )
    .join('')

  return `query Refresh($viewer: String!, ${parameters}) {${blocks}\n}`
}

export function refreshVariables(
  viewer: string,
  refs: readonly PullRequestRef[],
): Record<string, unknown> {
  const variables: Record<string, unknown> = { viewer }

  refs.forEach((ref, index) => {
    variables[`owner${index}`] = ref.owner
    variables[`name${index}`] = ref.name
    variables[`number${index}`] = ref.number
  })

  return variables
}

/** A GitHub call that failed. Its message is what ends up in the run history. */
export class GitHubApiError extends Error {
  override readonly name = 'GitHubApiError'
}

/** The most pull requests one discovery search returns. Beyond this is not a review queue. */
export const DISCOVERY_LIMIT = 50

/** The most pull requests one refresh request follows. The rest go on the next run. */
export const REFRESH_BATCH = 50

export interface GitHubApiOptions {
  readonly token: string
  readonly endpoint?: string
  /** Injected so nothing in the suite has to reach the network to test the client itself. */
  readonly fetch?: typeof globalThis.fetch
}

interface GraphQlResponse {
  readonly data?: Record<string, unknown> | null
  readonly errors?: ReadonlyArray<{ readonly message?: unknown }>
}

/**
 * Rate limiting is handled by respecting GitHub's own headers rather than by sleeping a
 * fixed amount: the run fails, saying when the limit resets, and the scheduler's backoff
 * decides when to try again. Spec 02.
 */
function rateLimitMessage(response: Response): string | null {
  if (response.status !== 403 && response.status !== 429) return null

  const retryAfter = response.headers.get('retry-after')
  if (retryAfter !== null) return `GitHub rate limit reached: retry after ${retryAfter} seconds`

  const reset = response.headers.get('x-ratelimit-reset')
  if (response.headers.get('x-ratelimit-remaining') === '0' && reset !== null) {
    return `GitHub rate limit reached: resets at ${new Date(Number(reset) * 1000).toISOString()}`
  }

  return null
}

export function createGitHubApi({
  token,
  endpoint = 'https://api.github.com/graphql',
  fetch = globalThis.fetch,
}: GitHubApiOptions): GitHubApi {
  async function run(query: string, variables: Record<string, unknown>): Promise<GraphQlResponse> {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/vnd.github+json',
      },
      body: JSON.stringify({ query, variables }),
    })

    const limited = rateLimitMessage(response)
    if (limited !== null) throw new GitHubApiError(limited)

    if (!response.ok) {
      throw new GitHubApiError(`GitHub answered ${response.status} ${response.statusText}`)
    }

    const body = (await response.json()) as GraphQlResponse

    // A GraphQL error arrives with a 200, so the status alone is not the answer.
    if (body.errors !== undefined && body.errors.length > 0) {
      const detail = body.errors
        .map((error) => (typeof error.message === 'string' ? error.message : 'unknown error'))
        .join('; ')
      throw new GitHubApiError(`GitHub rejected the query: ${detail}`)
    }

    return body
  }

  return {
    async viewerLogin() {
      const body = await run(viewerQuery, {})
      const login = (body.data as { viewer?: { login?: unknown } } | null)?.viewer?.login
      if (typeof login !== 'string' || login === '') {
        throw new GitHubApiError('GitHub did not say who the token belongs to')
      }
      return login
    },

    async searchReviewRequested(viewer) {
      const body = await run(discoveryQuery, {
        q: DISCOVERY_QUERY,
        viewer,
        first: DISCOVERY_LIMIT,
      })
      const nodes = (body.data as { search?: { nodes?: unknown } } | null)?.search?.nodes

      // A search node that is not a pull request comes back as an empty object, which is
      // what the type condition in the document leaves behind.
      return Array.isArray(nodes) ? nodes.filter(isPullRequestNode) : []
    },

    async pullRequests(viewer, refs) {
      if (refs.length === 0) return []

      const batch = refs.slice(0, REFRESH_BATCH)
      const body = await run(refreshQuery(batch), refreshVariables(viewer, batch))
      const data = (body.data ?? {}) as Record<string, { pullRequest?: unknown } | null>

      // A repository that has been deleted or a pull request that is no longer visible comes
      // back as null rather than as an error, and is simply not followed this run.
      return Object.values(data)
        .map((entry) => entry?.pullRequest)
        .filter(isPullRequestNode)
    },
  }
}

function isPullRequestNode(value: unknown): value is PullRequestNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { number?: unknown }).number === 'number' &&
    typeof (value as { headRefOid?: unknown }).headRefOid === 'string'
  )
}

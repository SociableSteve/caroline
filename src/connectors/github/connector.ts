/**
 * The GitHub connector: pull requests where you are a requested reviewer, followed until
 * they close. Two passes, because a review request disappears from GitHub's search results
 * the moment you submit a review, so a discovery query alone cannot follow a pull request
 * through its life. Spec 02.
 *
 *  1. **Discovery** finds new work.
 *  2. **Refresh** fetches every pull request Caroline already knows and has not seen close,
 *     whatever the search says. This is what makes the lifecycle possible.
 */
import type { ReviewOptions, ReviewPosition } from '../../domain/review.js'
import type { Connector, SourceItem } from '../types.js'
import type { GitHubApi, PullRequestNode } from './api.js'
import { externalIdOf, parseExternalId, toSourceItem } from './map.js'

/** What the engine knows about a pull request it has already seen. */
export interface KnownPullRequest extends ReviewPosition {
  readonly externalId: string
}

export interface GitHubConnectorOptions {
  readonly api: GitHubApi
  /** False with no token, which has the engine skip the connector rather than fail it. */
  readonly isConfigured: () => boolean
  readonly options: ReviewOptions
  /**
   * The unresolved GitHub sources, read at the moment the pass runs. A function rather than
   * a list because the connector is built once and runs repeatedly.
   */
  readonly known: () => readonly KnownPullRequest[]
}

const nowhere: ReviewPosition = { state: null, actedAt: null, actedAtMarker: null }

export function createGitHubConnector({
  api,
  isConfigured,
  options,
  known,
}: GitHubConnectorOptions): Connector {
  /** The token's owner does not change under a running process, so it is asked for once. */
  let viewer: string | null = null

  async function viewerLogin(): Promise<string> {
    viewer ??= await api.viewerLogin()
    return viewer
  }

  return {
    provider: 'github',
    isConfigured,

    async *fetch(): AsyncIterable<SourceItem> {
      const login = await viewerLogin()

      const discovered = await api.searchReviewRequested(login)
      const discoveredIds = new Set(discovered.map(externalIdOf))

      const followed = known()
      const positions = new Map(followed.map((entry) => [entry.externalId, entry]))

      // Only the ones discovery did not already return: the two passes read the same fields,
      // so a pull request in the search results needs no second fetch. Spec 02, criterion 18
      // is the other half of this: the ones discovery *has* dropped are exactly these.
      const refs = followed
        .filter((entry) => !discoveredIds.has(entry.externalId))
        .map((entry) => parseExternalId(entry.externalId))
        .filter((ref): ref is NonNullable<typeof ref> => ref !== null)

      const refreshed = await api.pullRequests(login, refs)

      for (const node of [...discovered, ...refreshed]) {
        yield item(node, login, discoveredIds, positions)
      }
    },
  }

  function item(
    node: PullRequestNode,
    login: string,
    discoveredIds: ReadonlySet<string>,
    positions: ReadonlyMap<string, ReviewPosition>,
  ): SourceItem {
    const externalId = externalIdOf(node)

    return toSourceItem(node, {
      viewer: login,
      discovered: discoveredIds.has(externalId),
      position: positions.get(externalId) ?? nowhere,
      options,
    })
  }
}

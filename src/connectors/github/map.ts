/**
 * Turning a pull request as GitHub describes it into the facts the review state machine
 * turns on, and then into a `SourceItem`. Pure, so the whole lifecycle can be walked in a
 * table test without a client or a database anywhere near it. Spec 02.
 */
import {
  nextReviewOutcome,
  type ReviewFacts,
  type ReviewOptions,
  type ReviewPosition,
} from '../../domain/review.js'
import type { SourceItem } from '../types.js'
import type { PullRequestNode, PullRequestRef, RequestedReviewer } from './api.js'
import { estimateReviewMinutes } from './estimate.js'

/** `owner/name#number`. Stable, human-readable, and enough to refetch the item from. */
export function externalIdOf(node: PullRequestNode): string {
  return `${node.repository.nameWithOwner}#${node.number}`
}

export function parseExternalId(externalId: string): PullRequestRef | null {
  const match = /^([^/\s]+)\/([^#/\s]+)#(\d+)$/.exec(externalId)
  if (match === null) return null

  const [, owner, name, number] = match
  if (owner === undefined || name === undefined || number === undefined) return null

  return { owner, name, number: Number(number) }
}

function epoch(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

function isViewer(reviewer: RequestedReviewer, viewer: string): boolean {
  return reviewer?.__typename === 'User' && reviewer.login === viewer
}

/**
 * A team request on a pull request Caroline is already following is a request to you: the
 * only reason the item is here at all is that it once came back from a search for review
 * requests made to you or to a team you belong to. Treating every team request as yours is
 * what keeps a team-requested pull request from looking like one you were dropped from the
 * moment it falls out of the discovery results.
 */
function isTeam(reviewer: RequestedReviewer): boolean {
  return reviewer?.__typename === 'Team'
}

export interface FactsContext {
  readonly viewer: string
  /** Whether this run's discovery search returned it. */
  readonly discovered: boolean
}

export function toReviewFacts(
  node: PullRequestNode,
  { viewer, discovered }: FactsContext,
): ReviewFacts {
  const requestedDirectly = node.reviewRequests.nodes.some((request) =>
    isViewer(request.requestedReviewer, viewer),
  )
  const requestedViaTeam = node.reviewRequests.nodes.some((request) =>
    isTeam(request.requestedReviewer),
  )

  const requestEvents = node.timelineItems.nodes
    .filter((event) => isViewer(event.requestedReviewer, viewer) || isTeam(event.requestedReviewer))
    .map((event) => epoch(event.createdAt))
    .filter((at): at is number => at !== null)

  const lastReview = node.reviews.nodes.at(-1) ?? null
  const headCommit = node.commits.nodes.at(-1)?.commit ?? null

  return {
    closed: node.state !== 'OPEN',
    reviewRequested: requestedDirectly || requestedViaTeam || discovered,
    reviewRequestedAt: requestEvents.length === 0 ? null : Math.max(...requestEvents),
    lastReviewState: lastReview?.state ?? null,
    lastReviewAt: epoch(lastReview?.submittedAt),
    lastReviewSha: lastReview?.commit?.oid ?? null,
    headSha: node.headRefOid,
    headCommittedAt: epoch(headCommit?.committedDate),
  }
}

/**
 * The metadata spec 02 asks be retained: repo, number, author, draft flag, additions,
 * deletions, changed files, requested-at, head sha, and your latest review state and its
 * timestamp. No body: the GitHub connector stores nothing that a content policy would have
 * an opinion about.
 */
export interface PullRequestMetadata {
  readonly repository: string
  readonly number: number
  readonly author: string | null
  readonly draft: boolean
  readonly additions: number
  readonly deletions: number
  readonly changedFiles: number
  readonly reviewRequestedAt: number | null
  readonly headSha: string
  readonly headCommittedAt: number | null
  readonly lastReviewState: string | null
  readonly lastReviewAt: number | null
}

export function toMetadata(node: PullRequestNode, facts: ReviewFacts): PullRequestMetadata {
  return {
    repository: node.repository.nameWithOwner,
    number: node.number,
    author: node.author?.login ?? null,
    draft: node.isDraft,
    additions: node.additions,
    deletions: node.deletions,
    changedFiles: node.changedFiles,
    reviewRequestedAt: facts.reviewRequestedAt,
    headSha: facts.headSha,
    headCommittedAt: facts.headCommittedAt,
    lastReviewState: facts.lastReviewState,
    lastReviewAt: facts.lastReviewAt,
  }
}

/** The board card's title. The repository and number are what identify it at a glance. */
export function titleOf(node: PullRequestNode): string {
  return `${node.repository.nameWithOwner}#${node.number} ${node.title}`
}

export interface MapContext extends FactsContext {
  readonly position: ReviewPosition
  readonly options: ReviewOptions
}

export function toSourceItem(
  node: PullRequestNode,
  { viewer, discovered, position, options }: MapContext,
): SourceItem {
  const facts = toReviewFacts(node, { viewer, discovered })
  const outcome = nextReviewOutcome(position, facts, options)

  return {
    externalId: externalIdOf(node),
    url: node.url,
    title: titleOf(node),
    metadata: { ...toMetadata(node, facts) },
    occurredAt: epoch(node.updatedAt) ?? 0,
    // Explicit either way, not just when true: the engine tells a genuine "still open" apart
    // from "this connector said nothing" by that distinction, and it is what lets a false
    // resolution (a review request the refresh pass finds restored) be retracted rather than
    // permanent.
    resolved: outcome.resolved,
    lifecycleState: outcome.state,
    actedAt: outcome.actedAt,
    actedAtMarker: outcome.actedAtMarker,
    task: {
      status: outcome.status,
      // A reviewed pull request is waiting on its author, by name: an unnamed chase is not
      // one. Set on every pass, so a pull request that changes hands follows.
      waitingOn: outcome.state === 'reviewed' ? (node.author?.login ?? null) : null,
      estimateMinutes: estimateReviewMinutes(node),
    },
  }
}

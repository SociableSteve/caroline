/**
 * The pull request review lifecycle, as a pure function of what is stored and what upstream
 * currently says. No network, no database, no clock: everything it needs is an argument,
 * which is what lets the whole state machine be walked in a table test. Spec 02.
 *
 * The point of the machine is the visibility guarantee: an open pull request is always in
 * either `review` or `waiting`, never completed, never hidden. Only a close, or being
 * dropped as a reviewer without having reviewed, ends it.
 */
import type { TaskStatus } from './task.js'

/** Where a pull request sits. Stored in `sources.lifecycle_state`. */
export const reviewStates = ['awaiting_review', 'reviewed', 'closed'] as const
export type ReviewState = (typeof reviewStates)[number]

/** The review states GitHub reports back for a submitted review. */
export type ReviewSubmissionState = 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED'

/** What upstream says right now, reduced to the facts the machine actually turns on. */
export interface ReviewFacts {
  /** Merged or closed. Either way the work has left you. */
  readonly closed: boolean
  /** You, or a team you belong to, are currently a requested reviewer. */
  readonly reviewRequested: boolean
  /** When that request was last made. Null when there is no request in the timeline. */
  readonly reviewRequestedAt: number | null
  /** Your latest review on this pull request, if you have submitted one. */
  readonly lastReviewState: ReviewSubmissionState | null
  readonly lastReviewAt: number | null
  /** The commit your latest review was submitted against. */
  readonly lastReviewSha: string | null
  readonly headSha: string
  readonly headCommittedAt: number | null
}

/** Where the machine last left this pull request, read from its source row. */
export interface ReviewPosition {
  readonly state: ReviewState | null
  readonly actedAt: number | null
  readonly actedAtMarker: string | null
}

export interface ReviewOptions {
  /**
   * Whether new commits after a changes-requested review pull the item back into `review`.
   * `github.returnToReviewOnNewCommits`, default true. Off, only an explicit re-request does.
   */
  readonly returnToReviewOnNewCommits: boolean
}

export interface ReviewOutcome {
  readonly state: ReviewState
  /** The status the connector wants the task in. Always inside its tracked set. */
  readonly status: TaskStatus
  readonly actedAt: number | null
  readonly actedAtMarker: string | null
  /**
   * True when the upstream item is finished with: merged, closed, or your review request
   * withdrawn before you ever reviewed. The engine resolves the source and proposes
   * completion; it never completes an open pull request.
   */
  readonly resolved: boolean
}

/** The one place `waiting` is chosen, so a reviewed pull request always names its author. */
export function reviewOutcomeStatus(state: ReviewState): TaskStatus {
  switch (state) {
    case 'awaiting_review':
      return 'review'
    case 'reviewed':
      return 'waiting'
    case 'closed':
      return 'done'
  }
}

function outcome(
  state: ReviewState,
  actedAt: number | null,
  actedAtMarker: string | null,
  resolved = false,
): ReviewOutcome {
  return { state, status: reviewOutcomeStatus(state), actedAt, actedAtMarker, resolved }
}

/**
 * Has the author pushed since you discharged your part? The marker is the head sha at the
 * moment you acted, so a different head means new commits. The timestamp is checked as well
 * where upstream supplies one: a force push that rewrites history to an older commit still
 * changes the sha, and only change *after* you acted counts.
 */
export function hasNewCommitsSinceActing(
  facts: Pick<ReviewFacts, 'headSha' | 'headCommittedAt'>,
  position: Pick<ReviewPosition, 'actedAt' | 'actedAtMarker'>,
): boolean {
  if (position.actedAt === null || position.actedAtMarker === null) return false
  if (facts.headSha === position.actedAtMarker) return false

  return facts.headCommittedAt === null || facts.headCommittedAt > position.actedAt
}

/**
 * The next position, given the last one and what upstream says now.
 *
 * The order of the rules is the specification, in order:
 *
 * 1. A closed pull request is closed, from any state.
 * 2. A review you submitted upstream later than the marker discharges your part, whatever
 *    the stored state was. The marker becomes the commit you reviewed.
 * 3. Once you have acted, only upstream activity *newer than the marker* pulls it back: a
 *    re-request, or new commits after a changes-requested review. This is what stops a
 *    marked-reviewed pull request bouncing back to `review` on the next sync fifteen
 *    minutes later.
 * 4. Otherwise a standing review request means it is yours.
 * 5. Otherwise nobody is asking you and you never reviewed: you were dropped as a reviewer,
 *    which is the one case where leaving the discovery results really does mean the work
 *    has gone.
 */
export function nextReviewOutcome(
  position: ReviewPosition,
  facts: ReviewFacts,
  options: ReviewOptions,
): ReviewOutcome {
  if (facts.closed) {
    return outcome('closed', position.actedAt, position.actedAtMarker, true)
  }

  const reviewedUpstream =
    facts.lastReviewAt !== null &&
    (position.actedAt === null || facts.lastReviewAt > position.actedAt)

  if (reviewedUpstream) {
    return outcome('reviewed', facts.lastReviewAt, facts.lastReviewSha ?? facts.headSha)
  }

  if (position.actedAt !== null) {
    const reRequested =
      facts.reviewRequestedAt !== null && facts.reviewRequestedAt > position.actedAt
    const pushedBack =
      options.returnToReviewOnNewCommits &&
      facts.lastReviewState === 'CHANGES_REQUESTED' &&
      hasNewCommitsSinceActing(facts, position)

    return reRequested || pushedBack
      ? outcome('awaiting_review', position.actedAt, position.actedAtMarker)
      : outcome('reviewed', position.actedAt, position.actedAtMarker)
  }

  if (facts.reviewRequested) {
    return outcome('awaiting_review', null, null)
  }

  // Dropped without having reviewed. Resolved, but still only a proposal to complete.
  return { ...outcome('awaiting_review', null, null), resolved: true }
}

/**
 * Marking a pull request reviewed from Caroline. Identical to having reviewed it on GitHub,
 * except that the marker is wherever upstream is now rather than the commit a review names.
 * Covers reviewing away from a keyboard, approving in a call, or deciding it does not need
 * your eyes.
 */
export function markReviewedOutcome(headSha: string, at: number): ReviewOutcome {
  return outcome('reviewed', at, headSha)
}

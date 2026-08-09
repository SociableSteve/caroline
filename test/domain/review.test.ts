/**
 * The review state machine on its own, with no client, database or clock anywhere near it.
 * Spec 02's transitions, one test each, plus the guarantee that holds them together: an
 * open pull request is never resolved.
 */
import { describe, expect, it } from 'vitest'
import {
  hasNewCommitsSinceActing,
  markReviewedOutcome,
  nextReviewOutcome,
  reviewStates,
  type ReviewFacts,
  type ReviewPosition,
} from '../../src/domain/review.js'

const REQUESTED_AT = Date.UTC(2026, 0, 5, 9, 12)
const REVIEWED_AT = Date.UTC(2026, 0, 6, 14, 0)
const PUSHED_AT = Date.UTC(2026, 0, 7, 10, 0)

const HEAD = 'sha-head'
const OLDER = 'sha-older'

const nowhere: ReviewPosition = { state: null, actedAt: null, actedAtMarker: null }

const requested: ReviewFacts = {
  closed: false,
  reviewRequested: true,
  reviewRequestedAt: REQUESTED_AT,
  lastReviewState: null,
  lastReviewAt: null,
  lastReviewSha: null,
  headSha: HEAD,
  headCommittedAt: REQUESTED_AT,
}

const on = { returnToReviewOnNewCommits: true }
const off = { returnToReviewOnNewCommits: false }

/** Where the machine leaves a pull request after you have discharged your part. */
const acted: ReviewPosition = { state: 'reviewed', actedAt: REVIEWED_AT, actedAtMarker: OLDER }

describe('a new review request', () => {
  it('puts the pull request in review, with nothing acted on yet', () => {
    expect(nextReviewOutcome(nowhere, requested, on)).toEqual({
      state: 'awaiting_review',
      status: 'review',
      actedAt: null,
      actedAtMarker: null,
      resolved: false,
    })
  })
})

describe('submitting a review on GitHub', () => {
  it('moves it to waiting, marked at the commit you reviewed', () => {
    const facts: ReviewFacts = {
      ...requested,
      reviewRequested: false,
      lastReviewState: 'COMMENTED',
      lastReviewAt: REVIEWED_AT,
      lastReviewSha: OLDER,
    }

    expect(
      nextReviewOutcome(
        { state: 'awaiting_review', actedAt: null, actedAtMarker: null },
        facts,
        on,
      ),
    ).toEqual({
      state: 'reviewed',
      status: 'waiting',
      actedAt: REVIEWED_AT,
      actedAtMarker: OLDER,
      resolved: false,
    })
  })

  it('never completes it: an open pull request stays visible', () => {
    const facts: ReviewFacts = {
      ...requested,
      reviewRequested: false,
      lastReviewState: 'APPROVED',
      lastReviewAt: REVIEWED_AT,
      lastReviewSha: HEAD,
    }

    expect(nextReviewOutcome(nowhere, facts, on).resolved).toBe(false)
  })

  it('falls back to the current head when the review names no commit', () => {
    const facts: ReviewFacts = {
      ...requested,
      lastReviewState: 'APPROVED',
      lastReviewAt: REVIEWED_AT,
      lastReviewSha: null,
    }

    expect(nextReviewOutcome(nowhere, facts, on).actedAtMarker).toBe(HEAD)
  })
})

describe('marking it reviewed in Caroline', () => {
  it('is the same move, marked at wherever upstream is now', () => {
    expect(markReviewedOutcome(HEAD, REVIEWED_AT)).toEqual({
      state: 'reviewed',
      status: 'waiting',
      actedAt: REVIEWED_AT,
      actedAtMarker: HEAD,
      resolved: false,
    })
  })

  it('stays put across any number of runs with nothing happening upstream', () => {
    // The review request is still standing, because you never reviewed it on GitHub. Without
    // the marker this is exactly the case that would bounce back to review every sync.
    const stillRequested: ReviewFacts = { ...requested, headSha: HEAD }
    let position: ReviewPosition = { state: 'reviewed', actedAt: REVIEWED_AT, actedAtMarker: HEAD }

    for (let run = 0; run < 5; run += 1) {
      const outcome = nextReviewOutcome(position, stillRequested, on)
      expect(outcome).toMatchObject({ state: 'reviewed', status: 'waiting' })
      position = {
        state: outcome.state,
        actedAt: outcome.actedAt,
        actedAtMarker: outcome.actedAtMarker,
      }
    }
  })
})

describe('going back to review', () => {
  it('happens when your review is re-requested after you acted', () => {
    const facts: ReviewFacts = { ...requested, reviewRequestedAt: PUSHED_AT }

    expect(nextReviewOutcome(acted, facts, on)).toMatchObject({
      state: 'awaiting_review',
      status: 'review',
      // The marker survives: it is what "after you acted" is measured against.
      actedAt: REVIEWED_AT,
      actedAtMarker: OLDER,
    })
  })

  it('does not happen for a request that predates your acting', () => {
    const facts: ReviewFacts = { ...requested, reviewRequestedAt: REQUESTED_AT }

    expect(nextReviewOutcome(acted, facts, on)).toMatchObject({ state: 'reviewed' })
  })

  it('happens on new commits when your last review requested changes', () => {
    const facts: ReviewFacts = {
      ...requested,
      reviewRequested: false,
      reviewRequestedAt: REQUESTED_AT,
      lastReviewState: 'CHANGES_REQUESTED',
      lastReviewAt: REVIEWED_AT,
      lastReviewSha: OLDER,
      headSha: HEAD,
      headCommittedAt: PUSHED_AT,
    }

    expect(nextReviewOutcome(acted, facts, on)).toMatchObject({ state: 'awaiting_review' })
  })

  it('does not happen on new commits when your last review approved it', () => {
    const facts: ReviewFacts = {
      ...requested,
      reviewRequested: false,
      reviewRequestedAt: REQUESTED_AT,
      lastReviewState: 'APPROVED',
      lastReviewAt: REVIEWED_AT,
      lastReviewSha: OLDER,
      headSha: HEAD,
      headCommittedAt: PUSHED_AT,
    }

    expect(nextReviewOutcome(acted, facts, on)).toMatchObject({ state: 'reviewed' })
  })

  it('does not happen on new commits at all with returnToReviewOnNewCommits off', () => {
    const facts: ReviewFacts = {
      ...requested,
      reviewRequested: false,
      reviewRequestedAt: REQUESTED_AT,
      lastReviewState: 'CHANGES_REQUESTED',
      lastReviewAt: REVIEWED_AT,
      lastReviewSha: OLDER,
      headSha: HEAD,
      headCommittedAt: PUSHED_AT,
    }

    expect(nextReviewOutcome(acted, facts, off)).toMatchObject({ state: 'reviewed' })
  })

  it('still happens on an explicit re-request with the setting off', () => {
    const facts: ReviewFacts = { ...requested, reviewRequestedAt: PUSHED_AT }

    expect(nextReviewOutcome(acted, facts, off)).toMatchObject({ state: 'awaiting_review' })
  })
})

describe('new commits since acting', () => {
  it('are what a different head sha means', () => {
    expect(
      hasNewCommitsSinceActing(
        { headSha: HEAD, headCommittedAt: PUSHED_AT },
        { actedAt: REVIEWED_AT, actedAtMarker: OLDER },
      ),
    ).toBe(true)
  })

  it('are not the same sha at a later timestamp', () => {
    expect(
      hasNewCommitsSinceActing(
        { headSha: OLDER, headCommittedAt: PUSHED_AT },
        { actedAt: REVIEWED_AT, actedAtMarker: OLDER },
      ),
    ).toBe(false)
  })

  it('do not count when the commit predates your acting, however the sha moved', () => {
    // A force push back to an older commit changes the sha without adding anything after you
    // looked, which is a different thing from the author responding.
    expect(
      hasNewCommitsSinceActing(
        { headSha: HEAD, headCommittedAt: REQUESTED_AT },
        { actedAt: REVIEWED_AT, actedAtMarker: OLDER },
      ),
    ).toBe(false)
  })

  it('cannot be judged before you have acted', () => {
    expect(
      hasNewCommitsSinceActing(
        { headSha: HEAD, headCommittedAt: PUSHED_AT },
        { actedAt: null, actedAtMarker: null },
      ),
    ).toBe(false)
  })
})

describe('closing', () => {
  it.each(['awaiting_review', 'reviewed'] as const)('resolves it from %s', (state) => {
    const facts: ReviewFacts = { ...requested, closed: true }
    const position: ReviewPosition = { state, actedAt: REVIEWED_AT, actedAtMarker: OLDER }

    expect(nextReviewOutcome(position, facts, on)).toMatchObject({
      state: 'closed',
      status: 'done',
      resolved: true,
    })
  })
})

describe('being dropped as a reviewer', () => {
  it('resolves it when you never reviewed', () => {
    const facts: ReviewFacts = { ...requested, reviewRequested: false, reviewRequestedAt: null }

    expect(nextReviewOutcome(nowhere, facts, on).resolved).toBe(true)
  })

  it('does not resolve it after you have reviewed: an open pull request is still yours to chase', () => {
    const facts: ReviewFacts = {
      ...requested,
      reviewRequested: false,
      reviewRequestedAt: null,
      lastReviewState: 'APPROVED',
      lastReviewAt: REVIEWED_AT,
      lastReviewSha: OLDER,
    }

    expect(nextReviewOutcome(acted, facts, on)).toMatchObject({
      state: 'reviewed',
      status: 'waiting',
      resolved: false,
    })
  })
})

describe('the visibility guarantee', () => {
  /** Every position the machine can be in, crossed with every open shape of the facts. */
  const positions: ReviewPosition[] = [
    nowhere,
    { state: 'awaiting_review', actedAt: null, actedAtMarker: null },
    acted,
    { state: 'closed', actedAt: REVIEWED_AT, actedAtMarker: OLDER },
  ]

  const openFacts: ReviewFacts[] = [
    requested,
    { ...requested, reviewRequested: false, reviewRequestedAt: PUSHED_AT },
    {
      ...requested,
      reviewRequested: false,
      lastReviewState: 'CHANGES_REQUESTED',
      lastReviewAt: REVIEWED_AT,
      lastReviewSha: OLDER,
      headCommittedAt: PUSHED_AT,
    },
    {
      ...requested,
      reviewRequested: false,
      reviewRequestedAt: null,
      lastReviewState: 'APPROVED',
      lastReviewAt: REVIEWED_AT,
      lastReviewSha: HEAD,
    },
  ]

  it('leaves an open pull request in review or waiting, whatever the position and the facts', () => {
    for (const position of positions) {
      for (const facts of openFacts) {
        const outcome = nextReviewOutcome(position, facts, on)

        expect([outcome.state, outcome.status]).not.toContain('closed')
        expect(outcome.status).toMatch(/^(review|waiting)$/)
      }
    }
  })

  it('names every state the machine can reach, so none is unreachable and untested', () => {
    expect(reviewStates).toEqual(['awaiting_review', 'reviewed', 'closed'])
  })
})

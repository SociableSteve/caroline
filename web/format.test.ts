import { describe, expect, it } from 'vitest'
import {
  ago,
  canMarkReviewed,
  dueState,
  formatAge,
  formatAgo,
  formatDate,
  formatDue,
  formatEstimate,
  hasOptedOutOfSync,
  hasPushedSinceReview,
  isCompletionProposed,
  isStale,
  statusLabel,
  waitingAge,
  waitingSince,
} from './format.js'
import { aPullRequestSource, aReviewTask, aTask } from './test-fixtures.js'

const DAY = 24 * 60 * 60 * 1000
const now = Date.UTC(2026, 5, 10)

describe('statusLabel', () => {
  it('names the status in the words the board uses', () => {
    expect(statusLabel('next_action')).toBe('Next actions')
    expect(statusLabel('waiting')).toBe('Waiting for')
  })
})

describe('formatAge', () => {
  it('says just now for anything under a minute', () => {
    expect(formatAge(0)).toBe('just now')
    expect(formatAge(59_000)).toBe('just now')
  })

  it('counts minutes, hours and days, singular where it should be', () => {
    expect(formatAge(60_000)).toBe('1 minute')
    expect(formatAge(2 * 60 * 60_000)).toBe('2 hours')
    expect(formatAge(DAY)).toBe('1 day')
    expect(formatAge(9 * DAY)).toBe('9 days')
  })
})

/**
 * Spec 08, criterion 20. Four call sites appended the word "ago" to an age, and one of the ages
 * is "just now", which is a moment rather than a duration.
 */
describe('formatAgo', () => {
  it('says just now, and never just now ago', () => {
    expect(formatAgo(0)).toBe('just now')
    expect(formatAgo(59_000)).toBe('just now')
  })

  it('puts every other age in the past', () => {
    expect(formatAgo(60_000)).toBe('1 minute ago')
    expect(formatAgo(9 * DAY)).toBe('9 days ago')
  })

  it('never reads as the future, however the two clocks disagree', () => {
    expect(ago(now + 60_000, now)).toBe('just now')
  })
})

/**
 * Spec 10: a date on its own asks the reader to know today's date and do the comparison, so
 * anywhere one is shown the state is named. Spec 08, criterion 18.
 */
describe('dueState and formatDue', () => {
  const midMorning = Date.UTC(2026, 5, 10, 9, 30)

  it('names a date that has passed as overdue, and keeps the date', () => {
    expect(dueState(midMorning - DAY, midMorning)).toBe('overdue')
    expect(formatDue(midMorning - DAY, midMorning)).toMatch(/^Overdue, /)
  })

  it('names today as today, including a time earlier today', () => {
    expect(dueState(midMorning, midMorning)).toBe('today')
    // Due at nine this morning is due today, not overdue by half an hour.
    expect(dueState(midMorning - 60 * 60_000, midMorning)).toBe('today')
    expect(formatDue(midMorning, midMorning)).toMatch(/^Today, /)
  })

  it('leaves a later date as the date alone', () => {
    expect(dueState(midMorning + DAY, midMorning)).toBe('later')
    expect(formatDue(midMorning + DAY, midMorning)).toBe(formatDate(midMorning + DAY))
  })

  /**
   * The boundary is the calendar's, not a fixed 86,400,000ms from midnight. Written against dates
   * derived the same way rather than against a pinned timezone, so it says what it means on any
   * machine: on the two days a year that are 23 or 25 hours long, adding a fixed span puts this
   * boundary an hour inside today or an hour into tomorrow, and one of these two fails.
   */
  it('ends today at the start of tomorrow, however long today happens to be', () => {
    const startOfTomorrow = new Date(midMorning)
    startOfTomorrow.setHours(0, 0, 0, 0)
    startOfTomorrow.setDate(startOfTomorrow.getDate() + 1)

    expect(dueState(startOfTomorrow.getTime() - 1, midMorning)).toBe('today')
    expect(dueState(startOfTomorrow.getTime(), midMorning)).toBe('later')
  })
})

describe('formatEstimate', () => {
  it('reads as minutes below an hour and as hours above it', () => {
    expect(formatEstimate(20)).toBe('20 min')
    expect(formatEstimate(60)).toBe('1 hour')
    expect(formatEstimate(150)).toBe('2 hours 30 min')
  })
})

describe('waitingAge', () => {
  it('measures from the moment it became somebody else’s turn', () => {
    expect(waitingAge({ statusSetAt: now - 3 * DAY, sources: [] }, now)).toBe(3 * DAY)
  })

  it('never goes negative, whatever a clock skew says', () => {
    expect(waitingAge({ statusSetAt: now + DAY, sources: [] }, now)).toBe(0)
  })
})

describe('isStale', () => {
  it('is false before the threshold and true once it is reached', () => {
    expect(isStale({ statusSetAt: now - 6 * DAY, sources: [] }, now, 7)).toBe(false)
    expect(isStale({ statusSetAt: now - 7 * DAY, sources: [] }, now, 7)).toBe(true)
  })

  it('follows the configured threshold rather than a built-in week', () => {
    expect(isStale({ statusSetAt: now - 3 * DAY, sources: [] }, now, 2)).toBe(true)
  })
})

describe('waitingSince', () => {
  it('is when you discharged your part, for a pull request', () => {
    const task = aReviewTask({
      status: 'waiting',
      statusSetAt: now,
      sources: [aPullRequestSource({ actedAt: now - 4 * DAY, actedAtMarker: 'sha-one' })],
    })

    expect(waitingSince(task)).toBe(now - 4 * DAY)
  })

  it('is when it became somebody else’s turn, for a task with no source', () => {
    expect(waitingSince({ statusSetAt: now - DAY, sources: [] })).toBe(now - DAY)
  })

  it('falls back to the status change on a source that has never been acted on', () => {
    const task = aReviewTask({ statusSetAt: now - DAY, sources: [aPullRequestSource()] })

    expect(waitingSince(task)).toBe(now - DAY)
  })
})

describe('hasPushedSinceReview', () => {
  const acted = { actedAt: now - 3 * DAY, actedAtMarker: 'sha-one' }

  it('is true when the head has moved on since you acted', () => {
    const task = aReviewTask({
      sources: [
        aPullRequestSource({ ...acted, metadata: { headSha: 'sha-two', headCommittedAt: now } }),
      ],
    })

    expect(hasPushedSinceReview(task)).toBe(true)
  })

  it('is false when the head is where you left it', () => {
    const task = aReviewTask({
      sources: [
        aPullRequestSource({
          ...acted,
          metadata: { headSha: 'sha-one', headCommittedAt: now - 4 * DAY },
        }),
      ],
    })

    expect(hasPushedSinceReview(task)).toBe(false)
  })

  it('is false for a task with no pull request behind it', () => {
    expect(hasPushedSinceReview({ sources: [] })).toBe(false)
  })
})

describe('marking a review done', () => {
  it('applies to an open pull request in Review that sync still follows', () => {
    expect(canMarkReviewed(aReviewTask())).toBe(true)
  })

  it.each([
    ['the task is not in Review', aReviewTask({ status: 'waiting' })],
    ['sync no longer follows it', aReviewTask({ syncTracked: false })],
    [
      'there is no pull request behind it',
      aTask({ id: 'task-1', title: 'Manual', status: 'review' }),
    ],
    [
      'the pull request has already closed',
      aReviewTask({ sources: [aPullRequestSource({ resolvedAt: now })] }),
    ],
  ])('does not apply when %s', (_why, task) => {
    expect(canMarkReviewed(task)).toBe(false)
  })
})

describe('a completion sync proposed', () => {
  it('is shown while the task is still open', () => {
    const task = aReviewTask({
      status: 'waiting',
      sources: [aPullRequestSource({ completionProposedAt: now })],
    })

    expect(isCompletionProposed(task)).toBe(true)
  })

  it('is not shown once the task is done, since the proposal was taken', () => {
    const task = aReviewTask({
      status: 'done',
      sources: [aPullRequestSource({ completionProposedAt: now })],
    })

    expect(isCompletionProposed(task)).toBe(false)
  })
})

describe('opting out of sync tracking', () => {
  it('is only meaningful for a task that came from somewhere', () => {
    expect(hasOptedOutOfSync({ syncTracked: false, sources: [aPullRequestSource()] })).toBe(true)
    expect(hasOptedOutOfSync({ syncTracked: false, sources: [] })).toBe(false)
    expect(hasOptedOutOfSync({ syncTracked: true, sources: [aPullRequestSource()] })).toBe(false)
  })
})

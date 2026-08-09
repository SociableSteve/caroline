import { describe, expect, it } from 'vitest'
import {
  estimateReviewMinutes,
  MAXIMUM_REVIEW_MINUTES,
  MINIMUM_REVIEW_MINUTES,
} from '../../../src/connectors/github/estimate.js'

/**
 * The heuristic is fixed and documented (spec 02), so the table is the documentation: if a
 * number here changes, the change was deliberate.
 */
describe('the pull request size estimate', () => {
  it.each([
    { additions: 0, deletions: 0, changedFiles: 0, minutes: 10 },
    { additions: 3, deletions: 1, changedFiles: 1, minutes: 10 },
    { additions: 120, deletions: 30, changedFiles: 6, minutes: 30 },
    { additions: 400, deletions: 100, changedFiles: 12, minutes: 60 },
    { additions: 1000, deletions: 400, changedFiles: 30, minutes: 140 },
  ])(
    '+$additions -$deletions over $changedFiles files is $minutes minutes',
    ({ minutes, ...size }) => {
      expect(estimateReviewMinutes(size)).toBe(minutes)
    },
  )

  it('never goes below the floor, because opening it costs something', () => {
    expect(estimateReviewMinutes({ additions: 0, deletions: 0, changedFiles: 0 })).toBe(
      MINIMUM_REVIEW_MINUTES,
    )
  })

  it('is clamped at the ceiling, which is what a generated lockfile hits', () => {
    expect(estimateReviewMinutes({ additions: 90_000, deletions: 12, changedFiles: 3 })).toBe(
      MAXIMUM_REVIEW_MINUTES,
    )
  })

  it('is rounded to five minutes, since it is a guess and should read like one', () => {
    const minutes = estimateReviewMinutes({ additions: 137, deletions: 22, changedFiles: 5 })

    expect(minutes % 5).toBe(0)
  })

  it('treats nonsense counts as zero rather than subtracting time', () => {
    expect(estimateReviewMinutes({ additions: -100, deletions: -100, changedFiles: -5 })).toBe(
      MINIMUM_REVIEW_MINUTES,
    )
  })
})

/**
 * How long something has been somebody else's problem. Spec 02 defines it once and three
 * places read it: the Waiting for column, the dashboard's chase list, and the daily plan's
 * nudges. They must not come to different answers about the same item, so the rule is here.
 */
import { describe, expect, it } from 'vitest'
import { isStaleWait, waitingAge, waitingSince } from '../../src/domain/waiting.js'

const NOW = Date.UTC(2026, 5, 10, 9, 0, 0)
const DAY = 24 * 60 * 60_000

describe('when the waiting started', () => {
  it('is when the status was set, for an item with no source behind it', () => {
    expect(waitingSince({ statusSetAt: NOW - DAY }, null)).toBe(NOW - DAY)
  })

  /** For a pull request it is the moment you discharged your part, not the moment it moved. */
  it('is when you acted, for a pull request', () => {
    expect(waitingSince({ statusSetAt: NOW }, { actedAt: NOW - 3 * DAY })).toBe(NOW - 3 * DAY)
  })

  it('falls back to the status change when the source has no acted-at yet', () => {
    expect(waitingSince({ statusSetAt: NOW - DAY }, { actedAt: null })).toBe(NOW - DAY)
  })
})

describe('the age', () => {
  it('is the gap to now', () => {
    expect(waitingAge({ statusSetAt: NOW - 2 * DAY }, null, NOW)).toBe(2 * DAY)
  })

  /** A clock that has gone backwards must not produce a negative age on a card. */
  it('is never negative', () => {
    expect(waitingAge({ statusSetAt: NOW + DAY }, null, NOW)).toBe(0)
  })
})

describe('staleness', () => {
  it('is reached at the threshold, not after it', () => {
    expect(isStaleWait({ statusSetAt: NOW - 7 * DAY }, null, NOW, 7)).toBe(true)
  })

  it('is not reached inside the threshold', () => {
    expect(isStaleWait({ statusSetAt: NOW - 6 * DAY }, null, NOW, 7)).toBe(false)
  })
})

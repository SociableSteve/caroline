import { describe, expect, it } from 'vitest'
import { formatAge, formatEstimate, isStale, statusLabel, waitingAge } from './format.js'

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

describe('formatEstimate', () => {
  it('reads as minutes below an hour and as hours above it', () => {
    expect(formatEstimate(20)).toBe('20 min')
    expect(formatEstimate(60)).toBe('1 hour')
    expect(formatEstimate(150)).toBe('2 hours 30 min')
  })
})

describe('waitingAge', () => {
  it('measures from the moment it became somebody else’s turn', () => {
    expect(waitingAge({ statusSetAt: now - 3 * DAY }, now)).toBe(3 * DAY)
  })

  it('never goes negative, whatever a clock skew says', () => {
    expect(waitingAge({ statusSetAt: now + DAY }, now)).toBe(0)
  })
})

describe('isStale', () => {
  it('is false before the threshold and true once it is reached', () => {
    expect(isStale({ statusSetAt: now - 6 * DAY }, now, 7)).toBe(false)
    expect(isStale({ statusSetAt: now - 7 * DAY }, now, 7)).toBe(true)
  })

  it('follows the configured threshold rather than a built-in week', () => {
    expect(isStale({ statusSetAt: now - 3 * DAY }, now, 2)).toBe(true)
  })
})

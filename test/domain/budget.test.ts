import { describe, expect, it } from 'vitest'
import { budgetReachedMessage, periodStart } from '../../src/domain/budget.js'

/** Midday UTC on the 15th of January 2026, a Thursday. */
const midJanuary = Date.UTC(2026, 0, 15, 12, 0, 0)

describe('periodStart', () => {
  it('starts a day at local midnight, not at a UTC boundary', () => {
    expect(periodStart(midJanuary, 'day', 'UTC')).toBe(Date.UTC(2026, 0, 15))
    expect(periodStart(midJanuary, 'day', 'Europe/Berlin')).toBe(Date.UTC(2026, 0, 14, 23))
  })

  it('starts a month at local midnight on the first', () => {
    expect(periodStart(midJanuary, 'month', 'UTC')).toBe(Date.UTC(2026, 0, 1))
    expect(periodStart(midJanuary, 'month', 'America/New_York')).toBe(Date.UTC(2026, 0, 1, 5))
  })

  it('resolves the boundary by the offset in force then, not by one fixed offset', () => {
    // The 1st of July in New York is four hours behind UTC, the 1st of January five. A single
    // offset applied to the whole table gets one of these two wrong, which is the reason a usage
    // day is resolved this way as well. Spec 03.
    const midJuly = Date.UTC(2026, 6, 15, 12, 0, 0)

    expect(periodStart(midJuly, 'month', 'America/New_York')).toBe(Date.UTC(2026, 6, 1, 4))
  })
})

describe('budgetReachedMessage, spec 03 criteria 13 and 14', () => {
  it('names the provider, the ceiling and the period, so a person can act on it', () => {
    const message = budgetReachedMessage('anthropic', 20, 'GBP', 'month')

    expect(message).toContain('anthropic')
    expect(message).toContain('20')
    expect(message).toContain('GBP')
    expect(message).toContain('month')
    expect(message).toContain('llm.budget')
  })
})

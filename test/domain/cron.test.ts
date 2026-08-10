import { describe, expect, it } from 'vitest'
import {
  CronError,
  cronInterval,
  isValidCron,
  isValidTimeZone,
  nextCronTime,
  parseCron,
} from '../../src/domain/cron.js'

const LONDON = 'Europe/London'
const UTC = 'UTC'

/** The next firing of an expression, as an ISO string, so a failure reads as a time. */
function next(expression: string, from: string, timeZone = UTC): string {
  return new Date(nextCronTime(parseCron(expression), Date.parse(from), timeZone)).toISOString()
}

describe('parsing a cron expression', () => {
  it('takes the five standard fields', () => {
    const fields = parseCron('30 7 * * *')

    expect([...fields.minutes]).toEqual([30])
    expect([...fields.hours]).toEqual([7])
    expect(fields.daysOfMonth.size).toBe(31)
    expect(fields.months.size).toBe(12)
    expect(fields.daysOfWeek.size).toBe(7)
  })

  it('expands a step', () => {
    expect([...parseCron('*/15 * * * *').minutes]).toEqual([0, 15, 30, 45])
  })

  it('expands a range with a step', () => {
    expect([...parseCron('0 9-17/4 * * *').hours]).toEqual([9, 13, 17])
  })

  it('expands a list', () => {
    expect([...parseCron('0,30 * * * *').minutes]).toEqual([0, 30])
  })

  it('treats a bare value with a step as running to the top of the field', () => {
    expect([...parseCron('5/20 * * * *').minutes]).toEqual([5, 25, 45])
  })

  it('reads Sunday as 0 whether the expression says 0 or 7', () => {
    expect([...parseCron('0 0 * * 7').daysOfWeek]).toEqual([0])
    expect([...parseCron('0 0 * * 0').daysOfWeek]).toEqual([0])
  })

  it.each([
    ['0 0 * *', 'four fields'],
    ['0 0 * * * *', 'six fields'],
    ['60 0 * * *', 'a minute out of range'],
    ['0 24 * * *', 'an hour out of range'],
    ['0 0 0 * *', 'a day of month out of range'],
    ['0 0 * 13 *', 'a month out of range'],
    ['0 0 * * 8', 'a day of week out of range'],
    ['*/0 * * * *', 'a zero step'],
    ['30-10 * * * *', 'a range that ends before it starts'],
    ['1-2-3 * * * *', 'two dashes'],
    ['abc * * * *', 'text where a number belongs'],
    ['', 'nothing at all'],
  ])('rejects %s (%s)', (expression) => {
    expect(() => parseCron(expression)).toThrow(CronError)
  })

  it('reports validity without throwing, which is what the config schema needs', () => {
    expect(isValidCron('*/15 * * * *')).toBe(true)
    expect(isValidCron('every quarter hour')).toBe(false)
  })
})

describe('the next firing', () => {
  it('is the next matching minute', () => {
    expect(next('*/15 * * * *', '2026-03-10T09:07:00Z')).toBe('2026-03-10T09:15:00.000Z')
  })

  it('is strictly after the moment asked about, so a firing does not repeat itself', () => {
    expect(next('*/15 * * * *', '2026-03-10T09:15:00Z')).toBe('2026-03-10T09:30:00.000Z')
  })

  it('ignores seconds within the current minute rather than firing twice in it', () => {
    expect(next('*/15 * * * *', '2026-03-10T09:15:42Z')).toBe('2026-03-10T09:30:00.000Z')
  })

  it('rolls into the next hour', () => {
    expect(next('*/15 * * * *', '2026-03-10T09:47:00Z')).toBe('2026-03-10T10:00:00.000Z')
  })

  it('rolls into the next day', () => {
    expect(next('5 * * * *', '2026-03-10T23:30:00Z')).toBe('2026-03-11T00:05:00.000Z')
  })

  it('rolls into the next month', () => {
    expect(next('30 7 1 * *', '2026-03-02T00:00:00Z')).toBe('2026-04-01T07:30:00.000Z')
  })

  it('finds the 29th of February, which is four years out at most', () => {
    expect(next('0 0 29 2 *', '2026-03-01T00:00:00Z')).toBe('2028-02-29T00:00:00.000Z')
  })

  it('refuses a date that never arrives rather than searching forever', () => {
    expect(() => next('0 0 30 2 *', '2026-03-01T00:00:00Z')).toThrow(CronError)
  })

  it('matches a day of the week', () => {
    // The 10th of March 2026 is a Tuesday, so the next Monday is the 16th.
    expect(next('0 9 * * 1', '2026-03-10T12:00:00Z')).toBe('2026-03-16T09:00:00.000Z')
  })

  /**
   * Cron's oldest quirk, and one worth pinning: with both day fields restricted, a date
   * matching either one fires. The 12th of March 2026 is a Thursday.
   */
  it('fires on either day field when both are restricted', () => {
    expect(next('0 9 12 * 1', '2026-03-10T12:00:00Z')).toBe('2026-03-12T09:00:00.000Z')
    expect(next('0 9 12 * 1', '2026-03-12T12:00:00Z')).toBe('2026-03-16T09:00:00.000Z')
  })
})

/**
 * Spec 06, criterion 4. The clocks go forward in London at 01:00 on 29 March 2026 and back at
 * 02:00 on 25 October 2026, so a daily 07:30 is 07:30 UTC before the change and 06:30 UTC
 * after it. The wall clock is what the schedule names.
 */
describe('a daily schedule across a DST boundary', () => {
  it('fires at 07:30 local time the day before the clocks go forward', () => {
    expect(next('30 7 * * *', '2026-03-28T12:00:00Z', LONDON)).toBe('2026-03-29T06:30:00.000Z')
  })

  it('fires at 07:30 local time on both sides of the spring change', () => {
    expect(next('30 7 * * *', '2026-03-27T12:00:00Z', LONDON)).toBe('2026-03-28T07:30:00.000Z')
    expect(next('30 7 * * *', '2026-03-29T12:00:00Z', LONDON)).toBe('2026-03-30T06:30:00.000Z')
  })

  it('fires at 07:30 local time on both sides of the autumn change', () => {
    expect(next('30 7 * * *', '2026-10-24T12:00:00Z', LONDON)).toBe('2026-10-25T07:30:00.000Z')
    expect(next('30 7 * * *', '2026-10-25T12:00:00Z', LONDON)).toBe('2026-10-26T07:30:00.000Z')
  })

  /**
   * 01:30 local does not exist on the morning the clocks go forward, so the schedule does not
   * fire that day rather than firing at some nearby time nobody asked for.
   */
  it('skips a wall-clock minute the timezone does not have', () => {
    expect(next('30 1 * * *', '2026-03-28T12:00:00Z', LONDON)).toBe('2026-03-30T00:30:00.000Z')
  })

  /**
   * 01:30 local happens twice on the morning the clocks go back. It fires on the first, and
   * the second is not a fresh firing: the answer moves on to the next day.
   */
  it('fires once in an hour the timezone repeats', () => {
    expect(next('30 1 * * *', '2026-10-25T00:00:00Z', LONDON)).toBe('2026-10-25T00:30:00.000Z')
    expect(next('30 1 * * *', '2026-10-25T00:30:00Z', LONDON)).toBe('2026-10-26T01:30:00.000Z')
  })
})

describe('the interval between firings', () => {
  it('is the cadence of a repeating schedule', () => {
    expect(cronInterval(parseCron('*/15 * * * *'), Date.parse('2026-03-10T09:00:00Z'), UTC)).toBe(
      15 * 60_000,
    )
  })

  it('is a day for a daily schedule', () => {
    expect(cronInterval(parseCron('30 7 * * *'), Date.parse('2026-03-10T09:00:00Z'), UTC)).toBe(
      24 * 60 * 60_000,
    )
  })

  /**
   * The two firings either side of the spring change are 23 hours apart in real time while
   * both read 07:30 on the wall. The cadence a job is judged overdue against is the real gap,
   * not the nominal one.
   */
  it('is measured in real time, so a day that loses an hour is 23 of them', () => {
    expect(cronInterval(parseCron('30 7 * * *'), Date.parse('2026-03-28T00:00:00Z'), LONDON)).toBe(
      23 * 60 * 60_000,
    )
  })
})

describe('timezone validation', () => {
  it('accepts a zone this runtime knows', () => {
    expect(isValidTimeZone(LONDON)).toBe(true)
  })

  it('rejects one it does not', () => {
    expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false)
  })
})

/**
 * The settings the daily plan is drawn against: the working window, the reserve, the default
 * estimate and the calendar window. Spec 05 gives every one of them a default, and this is
 * where a self-hoster who never opens the config file gets them.
 */
import { describe, expect, it } from 'vitest'
import { ConfigError, loadConfig } from '../../src/config/load.js'

const noEnv = {} as NodeJS.ProcessEnv

function withFile(file: unknown) {
  return loadConfig({ file, env: noEnv })
}

function planningFile(planning: Record<string, unknown>) {
  return { planning }
}

describe('the defaults spec 05 names', () => {
  const config = withFile(null)

  it('works nine to half five', () => {
    expect(config.planning.workingWindow).toEqual({ start: '09:00', end: '17:30' })
  })

  it('works Monday to Friday, with Sunday as zero', () => {
    expect(config.planning.workingDays).toEqual([1, 2, 3, 4, 5])
  })

  it('holds a fifth of the day back for interruptions', () => {
    expect(config.planning.reservePercent).toBe(20)
  })

  it('fits an unestimated task at half an hour', () => {
    expect(config.planning.defaultEstimateMinutes).toBe(30)
  })

  /** Spec 02: a public holiday and a week-long conference are both all-day events. */
  it('does not let an all-day event take the day', () => {
    expect(config.planning.countAllDayEvents).toBe(false)
  })

  /** Spec 05, criterion 19: an install that never names the key plans as it always did. */
  it('includes pull request reviews in the plan', () => {
    expect(config.planning.includeReviews).toBe(true)
  })

  it('includes them with a planning block that names other keys and not this one', () => {
    const namingOtherPlanningKeys = withFile(planningFile({ reservePercent: 25 }))

    expect(namingOtherPlanningKeys.planning.includeReviews).toBe(true)
  })

  /** Spec 02's rolling window: a day back, a fortnight forward. */
  it('reads a day back and a fortnight forward of calendar', () => {
    expect(config.integrations.google.calendarLookbackDays).toBe(1)
    expect(config.integrations.google.calendarLookaheadDays).toBe(14)
  })

  it('reads the primary calendar and no others until told otherwise', () => {
    expect(config.integrations.google.calendarIds).toEqual([])
  })

  /** Spec 06: daily at a configurable local time, default 07:30. */
  it('plans the day at half past seven', () => {
    expect(config.jobs.schedules.plan).toBe('30 7 * * *')
  })
})

describe('changing them', () => {
  it('takes a working window from the file', () => {
    const config = withFile(planningFile({ workingWindow: { start: '08:00', end: '16:00' } }))

    expect(config.planning.workingWindow).toEqual({ start: '08:00', end: '16:00' })
  })

  it('takes a six-day week', () => {
    const config = withFile(planningFile({ workingDays: [1, 2, 3, 4, 5, 6] }))

    expect(config.planning.workingDays).toEqual([1, 2, 3, 4, 5, 6])
  })

  /** Spec 05, criterion 18: for somebody whose code review is handled elsewhere. */
  it('takes reviews out of the plan altogether', () => {
    const config = withFile(planningFile({ includeReviews: false }))

    expect(config.planning.includeReviews).toBe(false)
  })

  it('takes additional calendars to read', () => {
    const config = withFile({
      integrations: { google: { calendarIds: ['team@example.com'] } },
    })

    expect(config.integrations.google.calendarIds).toEqual(['team@example.com'])
  })

  it('takes a plan schedule from the file', () => {
    const config = withFile({ jobs: { schedules: { plan: '0 6 * * 1-5' } } })

    expect(config.jobs.schedules.plan).toBe('0 6 * * 1-5')
  })
})

describe('settings that would produce a nonsensical day', () => {
  it('rejects a window that ends before it starts', () => {
    expect(() =>
      withFile(planningFile({ workingWindow: { start: '17:00', end: '09:00' } })),
    ).toThrow(ConfigError)
  })

  it('rejects a window with no length in it', () => {
    expect(() =>
      withFile(planningFile({ workingWindow: { start: '09:00', end: '09:00' } })),
    ).toThrow(ConfigError)
  })

  it.each(['9:00', '09:60', '25:00', 'morning', '0900'])(
    'rejects "%s" as a time of day',
    (start) => {
      expect(() => withFile(planningFile({ workingWindow: { start, end: '17:30' } }))).toThrow(
        ConfigError,
      )
    },
  )

  it('rejects a working week with no days in it', () => {
    expect(() => withFile(planningFile({ workingDays: [] }))).toThrow(ConfigError)
  })

  it('rejects a day of the week that is not one', () => {
    expect(() => withFile(planningFile({ workingDays: [1, 7] }))).toThrow(ConfigError)
  })

  it('rejects the same day twice, which would say nothing new', () => {
    expect(() => withFile(planningFile({ workingDays: [1, 1] }))).toThrow(ConfigError)
  })

  /** A hundred per cent reserve is a day with nothing in it, and nothing above it is meaningful. */
  it('rejects a reserve above a hundred per cent', () => {
    expect(() => withFile(planningFile({ reservePercent: 101 }))).toThrow(ConfigError)
  })

  it('accepts a reserve of zero, which is a real choice', () => {
    expect(withFile(planningFile({ reservePercent: 0 })).planning.reservePercent).toBe(0)
  })

  it('rejects a default estimate of zero, which would fit an unlimited number of tasks', () => {
    expect(() => withFile(planningFile({ defaultEstimateMinutes: 0 }))).toThrow(ConfigError)
  })

  it('rejects a calendar window that reaches no further than today', () => {
    expect(() => withFile({ integrations: { google: { calendarLookaheadDays: 0 } } })).toThrow(
      ConfigError,
    )
  })

  it('rejects a plan schedule that is not a cron expression', () => {
    expect(() => withFile({ jobs: { schedules: { plan: 'every morning' } } })).toThrow(ConfigError)
  })

  it('rejects a setting the schema does not know, rather than ignoring it', () => {
    expect(() => withFile(planningFile({ reserveMinutes: 60 }))).toThrow(ConfigError)
  })
})

/**
 * Where the plan's entries sit in the day's free time, once the present moment is taken into
 * account. Spec 05, criteria 21 to 23: an entry not yet done is never placed before `now`, a
 * done entry keeps the earlier time it was placed in whatever it is ranked behind, and free time
 * already gone is reported as gone rather than offered to anything.
 */
import { describe, expect, it } from 'vitest'
import { placeDay, type PlaceableEntry } from '../../src/domain/day-placement.js'
import type { Interval } from '../../src/domain/capacity.js'

const MINUTE = 60_000
const WINDOW_START = Date.UTC(2026, 5, 10, 9, 0, 0)

/** A plan entry needs nothing more than this to be placed. Named for what the test is about,
 *  the way every other fixture in this suite is. */
function anEntry(overrides: Partial<PlaceableEntry> = {}): PlaceableEntry {
  return { estimateMinutes: 30, done: false, ...overrides }
}

function totalMinutesOf(intervals: readonly Interval[]): number {
  return Math.round(
    intervals.reduce((total, interval) => total + (interval.end - interval.start), 0) / MINUTE,
  )
}

describe('placeDay', () => {
  it('places entries exactly as the old top-of-window walk did, with the whole window ahead', () => {
    const free = [{ start: WINDOW_START, end: WINDOW_START + 120 * MINUTE }]
    const a = anEntry({ estimateMinutes: 30 })
    const b = anEntry({ estimateMinutes: 45 })

    const placement = placeDay({ entries: [a, b], free, now: WINDOW_START })

    expect(placement.scheduled).toEqual([
      { entry: a, startsAt: WINDOW_START },
      { entry: b, startsAt: WINDOW_START + 30 * MINUTE },
    ])
    expect(placement.elapsed).toEqual([])
    expect(placement.gaps).toEqual([
      { startsAt: WINDOW_START + 75 * MINUTE, endsAt: WINDOW_START + 120 * MINUTE, minutes: 45 },
    ])
  })

  /** Criterion 21. */
  it('starts an outstanding entry read mid-window at now, not at the window start', () => {
    const free = [{ start: WINDOW_START, end: WINDOW_START + 120 * MINUTE }]
    const now = WINDOW_START + 60 * MINUTE
    const entry = anEntry({ estimateMinutes: 30 })

    const placement = placeDay({ entries: [entry], free, now })

    expect(placement.scheduled).toEqual([{ entry, startsAt: now }])
  })

  /** Criteria 21 and 22 together. */
  it('places a done entry at the window start and a not-done entry read mid-window at now', () => {
    const free = [{ start: WINDOW_START, end: WINDOW_START + 120 * MINUTE }]
    const now = WINDOW_START + 60 * MINUTE
    const done = anEntry({ estimateMinutes: 20, done: true })
    const notDone = anEntry({ estimateMinutes: 30, done: false })

    const placement = placeDay({ entries: [done, notDone], free, now })

    expect(placement.scheduled).toEqual([
      { entry: done, startsAt: WINDOW_START },
      { entry: notDone, startsAt: now },
    ])
  })

  /** Criterion 22, and the case one cursor floored at `now` gets wrong: a floored single cursor
   *  would place the not-done entry at `now` and then drag the done entry forward to right after
   *  it. */
  it('keeps a done entry ranked after an unfinished one at its own earlier time', () => {
    const free = [{ start: WINDOW_START, end: WINDOW_START + 120 * MINUTE }]
    const now = WINDOW_START + 60 * MINUTE
    const notDone = anEntry({ estimateMinutes: 30, done: false })
    const done = anEntry({ estimateMinutes: 30, done: true })

    const placement = placeDay({ entries: [notDone, done], free, now })

    expect(placement.scheduled).toEqual([
      { entry: notDone, startsAt: now },
      { entry: done, startsAt: WINDOW_START },
    ])
  })

  /** Criterion 22. */
  it('runs completed work past now when there is more of it than elapsed time, and starts outstanding work after it', () => {
    const free = [{ start: WINDOW_START, end: WINDOW_START + 180 * MINUTE }]
    const now = WINDOW_START + 30 * MINUTE
    const done = anEntry({ estimateMinutes: 90, done: true })
    const notDone = anEntry({ estimateMinutes: 30, done: false })

    const placement = placeDay({ entries: [done, notDone], free, now })

    expect(placement.scheduled).toEqual([
      { entry: done, startsAt: WINDOW_START },
      { entry: notDone, startsAt: WINDOW_START + 90 * MINUTE },
    ])
  })

  /** Criterion 23. */
  it('reports free time behind the clock as elapsed and free time ahead as a gap, with no entries', () => {
    const free = [{ start: WINDOW_START, end: WINDOW_START + 120 * MINUTE }]
    const now = WINDOW_START + 50 * MINUTE

    const placement = placeDay({ entries: [], free, now })

    expect(placement.elapsed).toEqual([{ startsAt: WINDOW_START, endsAt: now, minutes: 50 }])
    expect(placement.gaps).toEqual([
      { startsAt: now, endsAt: WINDOW_START + 120 * MINUTE, minutes: 70 },
    ])
  })

  it('accounts for every free minute as placed, elapsed or a gap, never double, across a mixed day', () => {
    const free = [
      { start: WINDOW_START, end: WINDOW_START + 60 * MINUTE },
      { start: WINDOW_START + 90 * MINUTE, end: WINDOW_START + 240 * MINUTE },
    ]
    const now = WINDOW_START + 100 * MINUTE
    const done = anEntry({ estimateMinutes: 20, done: true })
    const notDone = anEntry({ estimateMinutes: 45, done: false })

    const placement = placeDay({ entries: [done, notDone], free, now })

    const placedMinutes = placement.scheduled.reduce(
      (total, { entry }) => total + (entry.estimateMinutes ?? 0),
      0,
    )
    const elapsedMinutes = totalMinutesOf(
      placement.elapsed.map((stretch) => ({ start: stretch.startsAt, end: stretch.endsAt })),
    )
    const gapMinutes = totalMinutesOf(
      placement.gaps.map((stretch) => ({ start: stretch.startsAt, end: stretch.endsAt })),
    )
    const freeMinutes = totalMinutesOf(free)

    expect(placedMinutes + elapsedMinutes + gapMinutes).toBe(freeMinutes)
  })

  it('sends an entry too big for what is left ahead back untimed, and still counts the sliver as a gap', () => {
    const free = [{ start: WINDOW_START, end: WINDOW_START + 60 * MINUTE }]
    const now = WINDOW_START + 50 * MINUTE
    const entry = anEntry({ estimateMinutes: 20, done: false })

    const placement = placeDay({ entries: [entry], free, now })

    expect(placement.scheduled).toEqual([{ entry, startsAt: null }])
    expect(placement.gaps).toEqual([
      { startsAt: now, endsAt: WINDOW_START + 60 * MINUTE, minutes: 10 },
    ])
  })

  /** Criterion 23. */
  it('places nothing outstanding, leaves no gaps and reports the rest as elapsed on a closed window', () => {
    const free = [{ start: WINDOW_START, end: WINDOW_START + 120 * MINUTE }]
    const now = WINDOW_START + 200 * MINUTE
    const entry = anEntry({ estimateMinutes: 30, done: false })

    const placement = placeDay({ entries: [entry], free, now })

    expect(placement.scheduled).toEqual([{ entry, startsAt: null }])
    expect(placement.gaps).toEqual([])
    expect(placement.elapsed).toEqual([
      { startsAt: WINDOW_START, endsAt: WINDOW_START + 120 * MINUTE, minutes: 120 },
    ])
  })

  it('skips a free interval wholly in the past, reporting it as elapsed, and uses the next one', () => {
    const free = [
      { start: WINDOW_START, end: WINDOW_START + 30 * MINUTE },
      { start: WINDOW_START + 100 * MINUTE, end: WINDOW_START + 160 * MINUTE },
    ]
    const now = WINDOW_START + 90 * MINUTE
    const entry = anEntry({ estimateMinutes: 20, done: false })

    const placement = placeDay({ entries: [entry], free, now })

    expect(placement.scheduled).toEqual([{ entry, startsAt: WINDOW_START + 100 * MINUTE }])
    expect(placement.elapsed).toEqual([
      { startsAt: WINDOW_START, endsAt: WINDOW_START + 30 * MINUTE, minutes: 30 },
    ])
  })

  it('places the next entry at the following interval’s own start when now falls inside a meeting', () => {
    // `free` never includes the meeting itself; this is the free interval right after it.
    const free = [{ start: WINDOW_START + 120 * MINUTE, end: WINDOW_START + 180 * MINUTE }]
    const now = WINDOW_START + 90 * MINUTE
    const entry = anEntry({ estimateMinutes: 15, done: false })

    const placement = placeDay({ entries: [entry], free, now })

    expect(placement.scheduled).toEqual([{ entry, startsAt: WINDOW_START + 120 * MINUTE }])
  })

  it('places an entry with no estimate at the cursor without consuming any time', () => {
    const free = [{ start: WINDOW_START, end: WINDOW_START + 60 * MINUTE }]
    const untimed = anEntry({ estimateMinutes: null, done: false })
    const timed = anEntry({ estimateMinutes: 30, done: false })

    const placement = placeDay({ entries: [untimed, timed], free, now: WINDOW_START })

    expect(placement.scheduled).toEqual([
      { entry: untimed, startsAt: WINDOW_START },
      { entry: timed, startsAt: WINDOW_START },
    ])
  })

  it('waits for the next interval when an entry does not fit the remainder of the current one', () => {
    const free = [
      { start: WINDOW_START, end: WINDOW_START + 20 * MINUTE },
      { start: WINDOW_START + 60 * MINUTE, end: WINDOW_START + 120 * MINUTE },
    ]
    const entry = anEntry({ estimateMinutes: 30, done: false })

    const placement = placeDay({ entries: [entry], free, now: WINDOW_START })

    expect(placement.scheduled).toEqual([{ entry, startsAt: WINDOW_START + 60 * MINUTE }])
  })

  it('places nothing and leaves nothing behind with no free intervals at all', () => {
    const entry = anEntry({ estimateMinutes: 30, done: false })

    const placement = placeDay({ entries: [entry], free: [], now: WINDOW_START })

    expect(placement.scheduled).toEqual([{ entry, startsAt: null }])
    expect(placement.gaps).toEqual([])
    expect(placement.elapsed).toEqual([])
  })

  it('keeps two abutting free intervals as two, rather than merging them', () => {
    const free = [
      { start: WINDOW_START, end: WINDOW_START + 30 * MINUTE },
      { start: WINDOW_START + 30 * MINUTE, end: WINDOW_START + 60 * MINUTE },
    ]
    const now = WINDOW_START + 45 * MINUTE

    const placement = placeDay({ entries: [], free, now })

    expect(placement.elapsed).toEqual([
      { startsAt: WINDOW_START, endsAt: WINDOW_START + 30 * MINUTE, minutes: 30 },
      { startsAt: WINDOW_START + 30 * MINUTE, endsAt: now, minutes: 15 },
    ])
    expect(placement.gaps).toEqual([
      { startsAt: now, endsAt: WINDOW_START + 60 * MINUTE, minutes: 15 },
    ])
  })
})

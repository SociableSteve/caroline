/**
 * Placement against the present moment as well as against the day's free intervals. Spec 05,
 * "Placement is not re-planning", criteria 21 to 23: an entry not yet done never draws before
 * `now`, a done entry keeps whatever earlier time it was placed in regardless of rank, and free
 * time already behind `now` is reported as elapsed rather than offered as a gap.
 */
import { describe, expect, it } from 'vitest'
import { placeDay, type PlaceableEntry, type DayPlacement } from '../../src/domain/day-placement.js'
import type { Interval } from '../../src/domain/capacity.js'

const MINUTE = 60_000
const WINDOW_START = Date.UTC(2026, 5, 8, 9, 0, 0)

/** A test entry, named so assertions can read which one placed where without guessing from an
 *  offset alone. */
interface TestEntry extends PlaceableEntry {
  readonly id: string
}

function entry(id: string, estimateMinutes: number | null, done = false): TestEntry {
  return { id, estimateMinutes, done }
}

/** Where `id` was placed, or undefined if it is not in the placement at all. */
function startOf(placement: DayPlacement<TestEntry>, id: string): number | null | undefined {
  return placement.scheduled.find((row) => row.entry.id === id)?.startsAt
}

function at(minutesFromStart: number): number {
  return WINDOW_START + minutesFromStart * MINUTE
}

function interval(startMinutes: number, endMinutes: number): Interval {
  return { start: at(startMinutes), end: at(endMinutes) }
}

function totalMinutes(intervals: readonly Interval[]): number {
  return intervals.reduce((total, i) => total + (i.end - i.start) / MINUTE, 0)
}

function totalOfStretches(stretches: readonly { readonly minutes: number }[]): number {
  return stretches.reduce((total, stretch) => total + stretch.minutes, 0)
}

describe('placeDay', () => {
  it('is byte-identical to a single rank-order walk with the whole window ahead (regression pin)', () => {
    const entries = [entry('a', 30), entry('b', 60), entry('c', 15)]
    const free = [interval(0, 120)]

    const placement = placeDay({ entries, free, now: at(0) })

    expect(startOf(placement, 'a')).toBe(at(0))
    expect(startOf(placement, 'b')).toBe(at(30))
    expect(startOf(placement, 'c')).toBe(at(90))
    expect(placement.gaps).toEqual([{ startsAt: at(105), endsAt: at(120), minutes: 15 }])
    expect(placement.elapsed).toEqual([])
  })

  // Criterion 21.
  it('starts an outstanding entry read mid-window at now, not at the window start', () => {
    const entries = [entry('a', 30)]
    const free = [interval(0, 120)]

    const placement = placeDay({ entries, free, now: at(45) })

    expect(startOf(placement, 'a')).toBe(at(45))
  })

  // Criteria 21 and 22.
  it('places a done entry at the window start and the entry after it at now, read mid-window', () => {
    const entries = [entry('done', 30, true), entry('outstanding', 20)]
    const free = [interval(0, 120)]

    const placement = placeDay({ entries, free, now: at(60) })

    expect(startOf(placement, 'done')).toBe(at(0))
    expect(startOf(placement, 'outstanding')).toBe(at(60))
  })

  /** The case a single cursor floored at `now` fails: ranked before the done entry, an
   *  unfinished one must not drag it forward. Criterion 22. */
  it('keeps a done entry’s earlier time when it is ranked after an unfinished one', () => {
    const entries = [entry('outstanding', 30), entry('done', 30, true)]
    const free = [interval(0, 120)]

    const placement = placeDay({ entries, free, now: at(60) })

    expect(startOf(placement, 'done')).toBe(at(0))
    expect(startOf(placement, 'outstanding')).toBe(at(60))
  })

  // Criterion 22.
  it('runs completed work past now when there is more of it than elapsed time, and starts outstanding work after it', () => {
    const entries = [entry('done', 90, true), entry('outstanding', 20)]
    const free = [interval(0, 120)]

    const placement = placeDay({ entries, free, now: at(30) })

    expect(startOf(placement, 'done')).toBe(at(0))
    expect(startOf(placement, 'outstanding')).toBe(at(90))
    expect(placement.elapsed).toEqual([])
  })

  // Criterion 23.
  it('reports free time behind the clock as elapsed and free time ahead as a gap, with no entries', () => {
    const free = [interval(0, 120)]

    const placement = placeDay({ entries: [], free, now: at(50) })

    expect(placement.elapsed).toEqual([{ startsAt: at(0), endsAt: at(50), minutes: 50 }])
    expect(placement.gaps).toEqual([{ startsAt: at(50), endsAt: at(120), minutes: 70 }])
  })

  /** The double-count guard: whatever the walk did, placed, elapsed and gap minutes always sum
   *  to the free minutes. */
  it('never double counts: placed plus elapsed plus gap minutes equal the free minutes', () => {
    const entries = [entry('done', 20, true), entry('a', 15), entry('b', 200)]
    const free = [interval(0, 60), interval(90, 150)]

    const placement = placeDay({ entries, free, now: at(40) })

    const placedMinutes = placement.scheduled.reduce(
      (total, row) => total + (row.startsAt === null ? 0 : (row.entry.estimateMinutes ?? 0)),
      0,
    )
    const freeMinutes = totalMinutes(free)

    expect(
      placedMinutes + totalOfStretches(placement.elapsed) + totalOfStretches(placement.gaps),
    ).toBe(freeMinutes)
  })

  it('leaves an entry too big for what is left ahead untimed, and the sliver still a gap', () => {
    const entries = [entry('big', 50)]
    const free = [interval(0, 40)]

    const placement = placeDay({ entries, free, now: at(0) })

    expect(startOf(placement, 'big')).toBeNull()
    expect(placement.gaps).toEqual([{ startsAt: at(0), endsAt: at(40), minutes: 40 }])
  })

  it('places nothing outstanding on a closed window, leaves no gaps, and reports the rest as elapsed', () => {
    const entries = [entry('a', 30)]
    const free = [interval(0, 60)]

    const placement = placeDay({ entries, free, now: at(120) })

    expect(startOf(placement, 'a')).toBeNull()
    expect(placement.gaps).toEqual([])
    expect(placement.elapsed).toEqual([{ startsAt: at(0), endsAt: at(60), minutes: 60 }])
  })

  it('skips a free interval wholly in the past, reporting it as elapsed, and uses the next one', () => {
    const entries = [entry('a', 30)]
    const free = [interval(0, 20), interval(50, 100)]

    const placement = placeDay({ entries, free, now: at(40) })

    expect(startOf(placement, 'a')).toBe(at(50))
    expect(placement.elapsed).toEqual([{ startsAt: at(0), endsAt: at(20), minutes: 20 }])
  })

  it('places an entry read while now is inside a meeting at the following interval’s own start', () => {
    // Free intervals never include the meeting itself, so "now inside a meeting" is simply a
    // `now` that falls in the gap between two free intervals.
    const entries = [entry('a', 10)]
    const free = [interval(0, 20), interval(40, 80)]

    const placement = placeDay({ entries, free, now: at(30) })

    expect(startOf(placement, 'a')).toBe(at(40))
  })

  it('places an entry with no estimate at the cursor without consuming any time', () => {
    const entries = [entry('none', null), entry('after', 10)]
    const free = [interval(0, 20)]

    const placement = placeDay({ entries, free, now: at(0) })

    expect(startOf(placement, 'none')).toBe(at(0))
    expect(startOf(placement, 'after')).toBe(at(0))
  })

  it('waits for the next interval when an entry does not fit the remainder of this one', () => {
    const entries = [entry('a', 15), entry('b', 30)]
    const free = [interval(0, 20), interval(40, 80)]

    const placement = placeDay({ entries, free, now: at(0) })

    expect(startOf(placement, 'a')).toBe(at(0))
    expect(startOf(placement, 'b')).toBe(at(40))
  })

  it('places nothing and leaves nothing behind with no free intervals at all', () => {
    const entries = [entry('a', 15)]

    const placement = placeDay({ entries, free: [], now: at(0) })

    expect(startOf(placement, 'a')).toBeNull()
    expect(placement.gaps).toEqual([])
    expect(placement.elapsed).toEqual([])
  })

  /** The do-not-merge trap: spec 08 criterion 41. */
  it('keeps two abutting free intervals as two, not merged into one', () => {
    const free = [interval(0, 20), interval(20, 40)]

    const placement = placeDay({ entries: [], free, now: at(50) })

    expect(placement.elapsed).toEqual([
      { startsAt: at(0), endsAt: at(20), minutes: 20 },
      { startsAt: at(20), endsAt: at(40), minutes: 20 },
    ])
  })
})

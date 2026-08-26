/**
 * Spec 05 criteria 21-23: placement logic for the daily plan, accounting for elapsed time.
 *
 * A day with completed entries ranked out of order keeps the earlier free time they were placed
 * in, and outstanding work starts only from the clock's current moment. Free time that has passed
 * is time gone rather than capacity: it is never offered to work the plan could not fit, and an
 * entry that no longer fits anywhere ahead is reported as having no time rather than given one
 * behind the clock.
 */
import { describe, expect, it } from 'vitest'
import type { Interval } from '../../src/domain/capacity.js'
import { placeDay } from '../../src/domain/day-placement.js'

const MINUTE_MS = 60_000

/**
 * Test fixtures that describe entries by estimate and completion.
 */
interface TestEntry {
  readonly id: string
  readonly estimateMinutes: number | null
  readonly done: boolean
}

function entry(id: string, estimateMinutes: number | null = null, done = false): TestEntry {
  return { id, estimateMinutes, done }
}

/**
 * Cases from the plan, testing that the walk behaves as described.
 */
describe('day placement', () => {
  const windowStart = 9 * 60 * 60_000
  const windowEnd = 17 * 60 * 60_000 + 30 * 60_000
  const now = windowStart + 4 * 60 * 60_000 // 13:00, four hours into the day

  describe('phase ordering and placement', () => {
    it('places the whole window as before when now is at the window start (regression: the old walk unchanged)', () => {
      const entries = [entry('a', 60), entry('b', 60), entry('c', 60)]
      const free = [{ start: windowStart, end: windowEnd }]
      const atStart = windowStart

      const result = placeDay({ entries, free, now: atStart })

      expect(result.scheduled).toEqual([
        { entry: entries[0], startsAt: windowStart },
        { entry: entries[1], startsAt: windowStart + 60 * MINUTE_MS },
        { entry: entries[2], startsAt: windowStart + 120 * MINUTE_MS },
      ])
      expect(result.gaps).toHaveLength(1)
      expect(result.gaps[0]).toEqual({
        startsAt: windowStart + 180 * MINUTE_MS,
        endsAt: windowEnd,
      })
      expect(result.elapsed).toHaveLength(0)
    })

    it('places outstanding entries at or after now when read mid-window (criterion 21)', () => {
      const entries = [entry('a', 60)]
      const free = [{ start: windowStart, end: windowEnd }]

      const result = placeDay({ entries, free, now })

      expect(result.scheduled[0]?.startsAt).toBe(now)
    })

    it('places done entries at the window start despite being ranked after outstanding entries (criterion 22)', () => {
      // Done first in rank order, unfinished second. If we floored both cursors at `now`,
      // the unfinished entry would place at `now` and the done one at `now + 60 min`,
      // dragging finished work into the future. That is the case one floored cursor gets wrong.
      const entries = [
        entry('done-after', 60, true), // ranked first but done
        entry('unfinished-before', 60, false), // ranked second but not done
      ]
      const free = [{ start: windowStart, end: windowEnd }]

      const result = placeDay({ entries, free, now })

      // Done entry places at window start, unfinished at now
      expect(result.scheduled[0]?.startsAt).toBe(windowStart)
      expect(result.scheduled[1]?.startsAt).toBe(now)
    })

    it('preserves done entry time when ranked after unfinished entry (criterion 22, the key test case)', () => {
      const entries = [
        entry('unfinished-first', 60, false), // ranked first
        entry('done-second', 60, true), // ranked second but done
      ]
      const free = [{ start: windowStart, end: windowEnd }]

      const result = placeDay({ entries, free, now })

      // Unfinished places at now, done keeps its earlier placement at window start
      expect(result.scheduled[0]?.startsAt).toBe(windowStart)
      expect(result.scheduled[1]?.startsAt).toBe(now)
    })

    it('runs completed work past now when it exceeds elapsed time (criterion 22)', () => {
      // 4 hours have elapsed (now is 4 hours into the day). Place 5 hours of done work.
      // It should run from window start through to 5 hours in, spilling 1 hour past now.
      const fiveHours = 5 * 60
      const entries = [entry('big-done', fiveHours, true)]
      const free = [{ start: windowStart, end: windowEnd }]

      const result = placeDay({ entries, free, now })

      expect(result.scheduled[0]?.startsAt).toBe(windowStart)
      expect(result.scheduled[0]?.entry.estimateMinutes).toBe(fiveHours)
      // Outstanding work starts after the done work
      expect(result.gaps[0]?.startsAt).toBe(windowStart + fiveHours * MINUTE_MS)
    })
  })

  describe('free time behind the clock', () => {
    it('reports elapsed time when the window is wholly behind now', () => {
      // An 8.5-hour window from 09:00 to 17:30, read at 13:00.
      // Four hours have elapsed. No entries placed.
      // Elapsed should be 4 hours.
      const entries: TestEntry[] = []
      const free = [{ start: windowStart, end: windowEnd }]

      const result = placeDay({ entries, free, now })

      expect(result.elapsed).toEqual([
        {
          startsAt: windowStart,
          endsAt: now,
        },
      ])
      expect(result.gaps).toEqual([
        {
          startsAt: now,
          endsAt: windowEnd,
        },
      ])
    })

    it('reports elapsed and gap when an interval straddles now', () => {
      // One free interval, split by now
      const entries: TestEntry[] = []
      const free = [{ start: windowStart, end: windowEnd }]

      const result = placeDay({ entries, free, now })

      expect(result.elapsed).toHaveLength(1)
      expect(result.elapsed[0]?.endsAt).toBe(now)
      expect(result.gaps).toHaveLength(1)
      expect(result.gaps[0]?.startsAt).toBe(now)
    })

    it('skips intervals wholly before now and reports them as elapsed', () => {
      // Two free intervals: one entirely before now, one entirely after
      const intervalBeforeNow = { start: windowStart, end: now - 30 * MINUTE_MS }
      const intervalAfterNow = { start: now + 60 * MINUTE_MS, end: windowEnd }
      const entries: TestEntry[] = []
      const free = [intervalBeforeNow, intervalAfterNow]

      const result = placeDay({ entries, free, now })

      expect(result.elapsed).toEqual([
        {
          startsAt: intervalBeforeNow.start,
          endsAt: intervalBeforeNow.end,
        },
      ])
      expect(result.gaps).toEqual([
        {
          startsAt: intervalAfterNow.start,
          endsAt: intervalAfterNow.end,
        },
      ])
    })

    it('reports nothing as elapsed when now is at window start', () => {
      const entries: TestEntry[] = []
      const free = [{ start: windowStart, end: windowEnd }]

      const result = placeDay({ entries, free, now: windowStart })

      expect(result.elapsed).toHaveLength(0)
      expect(result.gaps).toHaveLength(1)
    })

    it('reports everything as elapsed when now is at or past window end', () => {
      const entries: TestEntry[] = []
      const free = [{ start: windowStart, end: windowEnd }]
      const afterWindow = windowEnd + 60 * MINUTE_MS

      const result = placeDay({ entries, free, now: afterWindow })

      expect(result.elapsed).toEqual([
        {
          startsAt: windowStart,
          endsAt: windowEnd,
        },
      ])
      expect(result.gaps).toHaveLength(0)
    })
  })

  describe('placement invariants', () => {
    it('ensures placed + elapsed + gaps == free (the double-count guard)', () => {
      const entries = [entry('a', 60, false), entry('b', 60, true), entry('c', 60, false)]
      const free = [
        { start: windowStart, end: windowStart + 2 * 60 * MINUTE_MS },
        { start: windowStart + 3 * 60 * MINUTE_MS, end: windowEnd },
      ]

      const result = placeDay({ entries, free, now })

      const placedMinutes = result.scheduled
        .filter((s) => s.startsAt !== null)
        .reduce((total, s) => total + (s.entry.estimateMinutes ?? 0), 0)
      const elapsedMinutes = result.elapsed.reduce(
        (total, e) => total + (e.endsAt - e.startsAt) / MINUTE_MS,
        0,
      )
      const gapsMinutes = result.gaps.reduce(
        (total, g) => total + (g.endsAt - g.startsAt) / MINUTE_MS,
        0,
      )
      const freeMinutes = free.reduce((total, i) => total + (i.end - i.start) / MINUTE_MS, 0)

      expect(placedMinutes + elapsedMinutes + gapsMinutes).toBeCloseTo(freeMinutes, 0)
    })

    it('never places an outstanding entry before now', () => {
      const entries = [entry('a', 30, false), entry('b', 30, false)]
      const free = [{ start: windowStart, end: windowEnd }]

      const result = placeDay({ entries, free, now })

      for (const { entry: e, startsAt } of result.scheduled) {
        if (!e.done && startsAt !== null) {
          expect(startsAt).toBeGreaterThanOrEqual(now)
        }
      }
    })

    it('never moves a completed entry forward by unfinished work', () => {
      const entries = [
        entry('unfinished-1', 100, false),
        entry('done-early', 30, true),
        entry('unfinished-2', 100, false),
      ]
      const free = [{ start: windowStart, end: windowEnd }]

      const result = placeDay({ entries, free, now })

      const doneIdx = result.scheduled.findIndex((s) => s.entry.id === 'done-early')
      const unfinished1Idx = result.scheduled.findIndex((s) => s.entry.id === 'unfinished-1')
      const unfinished2Idx = result.scheduled.findIndex((s) => s.entry.id === 'unfinished-2')

      expect(doneIdx).not.toBe(-1)
      expect(unfinished1Idx).not.toBe(-1)
      expect(unfinished2Idx).not.toBe(-1)

      const doneTime = result.scheduled[doneIdx]?.startsAt
      const unfinished1Time = result.scheduled[unfinished1Idx]?.startsAt

      if (
        doneTime !== null &&
        unfinished1Time !== null &&
        doneTime !== undefined &&
        unfinished1Time !== undefined
      ) {
        // Done should be before or at window start, unfinished should be at or after now
        expect(doneTime).toBeLessThanOrEqual(unfinished1Time)
      }
    })
  })

  describe('entries with no estimate', () => {
    it('places an entry with no estimate at the cursor without consuming time', () => {
      const entries = [entry('normal', 60), entry('no-estimate', null), entry('another', 60)]
      const free = [{ start: windowStart, end: windowEnd }]

      const result = placeDay({ entries, free, now: windowStart })

      const noEstIdx = result.scheduled.findIndex((s) => s.entry.id === 'no-estimate')
      const normalIdx = result.scheduled.findIndex((s) => s.entry.id === 'normal')
      const anotherIdx = result.scheduled.findIndex((s) => s.entry.id === 'another')

      // All three should be placed
      expect(noEstIdx).not.toBe(-1)
      expect(normalIdx).not.toBe(-1)
      expect(anotherIdx).not.toBe(-1)

      // "normal" places at window start
      expect(result.scheduled[normalIdx]?.startsAt).toBe(windowStart)
      // "no-estimate" places at cursor after "normal"
      expect(result.scheduled[noEstIdx]?.startsAt).toBe(windowStart + 60 * MINUTE_MS)
      // "another" places at cursor after no-estimate (which consumed nothing)
      expect(result.scheduled[anotherIdx]?.startsAt).toBe(windowStart + 60 * MINUTE_MS)
    })
  })

  describe('oversized entries', () => {
    it('leaves an entry untimed when it does not fit the remainder of an interval', () => {
      // One 60-minute interval. Entry wants 120 minutes. Should come back untimed.
      const entries = [entry('too-big', 120)]
      const free = [{ start: windowStart, end: windowStart + 60 * MINUTE_MS }]

      const result = placeDay({ entries, free, now: windowStart })

      expect(result.scheduled[0]?.startsAt).toBeNull()
    })

    it('uses the next interval when an entry does not fit the remainder of the current one', () => {
      // Two 60-minute intervals. First entry consumes 50 minutes of the first interval.
      // Second entry (40 minutes) does not fit the 10-minute remainder.
      // So second entry goes into the second interval.
      const entries = [entry('a', 50), entry('b', 40)]
      const free = [
        { start: windowStart, end: windowStart + 60 * MINUTE_MS },
        { start: windowStart + 120 * MINUTE_MS, end: windowStart + 180 * MINUTE_MS },
      ]

      const result = placeDay({ entries, free, now: windowStart })

      expect(result.scheduled[0]?.startsAt).toBe(windowStart)
      expect(result.scheduled[1]?.startsAt).toBe(windowStart + 120 * MINUTE_MS)
    })

    it('reports the remainder of an interval as a gap', () => {
      // 60-minute interval, 50-minute entry, 10 minutes left
      const entries = [entry('a', 50)]
      const free = [{ start: windowStart, end: windowStart + 60 * MINUTE_MS }]

      const result = placeDay({ entries, free, now: windowStart })

      expect(result.gaps).toHaveLength(1)
      expect(result.gaps[0]?.startsAt).toBe(windowStart + 50 * MINUTE_MS)
      expect(result.gaps[0]?.endsAt).toBe(windowStart + 60 * MINUTE_MS)
    })
  })

  describe('edge cases', () => {
    it('handles no free intervals at all', () => {
      const entries = [entry('a', 60)]
      const free: Interval[] = []

      const result = placeDay({ entries, free, now })

      expect(result.scheduled[0]?.startsAt).toBeNull()
      expect(result.gaps).toHaveLength(0)
      expect(result.elapsed).toHaveLength(0)
    })

    it('keeps two abutting free intervals separate (do not merge)', () => {
      // Two intervals: one before now, one after now, abutting
      const interval1 = { start: windowStart, end: now }
      const interval2 = { start: now, end: windowEnd }
      const entries: TestEntry[] = []

      const result = placeDay({ entries, free: [interval1, interval2], now })

      expect(result.elapsed).toHaveLength(1)
      expect(result.gaps).toHaveLength(1)
      expect(result.elapsed[0]?.endsAt).toBe(now)
      expect(result.gaps[0]?.startsAt).toBe(now)
    })

    it('drops zero-length intervals', () => {
      const zeroInterval = { start: windowStart, end: windowStart }
      const normalInterval = {
        start: windowStart + 60 * MINUTE_MS,
        end: windowStart + 120 * MINUTE_MS,
      }
      const entries = [entry('a', 30)]

      const result = placeDay({ entries, free: [zeroInterval, normalInterval], now: windowStart })

      expect(result.scheduled[0]?.startsAt).toBe(normalInterval.start)
    })

    it('sorts intervals defensively when out of order', () => {
      // Provide intervals out of order
      const interval2 = { start: windowStart + 120 * MINUTE_MS, end: windowStart + 180 * MINUTE_MS }
      const interval1 = { start: windowStart, end: windowStart + 60 * MINUTE_MS }
      const entries = [entry('a', 30), entry('b', 30)]

      const result = placeDay({ entries, free: [interval2, interval1], now: windowStart })

      expect(result.scheduled[0]?.startsAt).toBe(windowStart)
      expect(result.scheduled[1]?.startsAt).toBe(windowStart + 30 * MINUTE_MS)
    })

    it('handles now falling inside a busy block (meeting)', () => {
      // One free interval before now, one after now (simulating a meeting in between)
      const beforeMeeting = { start: windowStart, end: now - 30 * MINUTE_MS }
      const afterMeeting = { start: now + 60 * MINUTE_MS, end: windowEnd }
      const entries = [entry('a', 60)]

      const result = placeDay({ entries, free: [beforeMeeting, afterMeeting], now })

      expect(result.scheduled[0]?.startsAt).toBe(afterMeeting.start)
    })
  })

  describe('with a closed window', () => {
    it('places no outstanding work and leaves no gaps when now is at or past window end', () => {
      const entries = [entry('a', 60)]
      const free = [{ start: windowStart, end: windowEnd }]
      const atEnd = windowEnd

      const result = placeDay({ entries, free, now: atEnd })

      expect(result.scheduled[0]?.startsAt).toBeNull()
      expect(result.gaps).toHaveLength(0)
    })
  })

  describe('zero-length free intervals', () => {
    it('filters out zero-length intervals before processing', () => {
      const validInterval = { start: windowStart, end: windowStart + 60 * MINUTE_MS }
      const zeroInterval1 = { start: windowStart, end: windowStart }
      const zeroInterval2 = {
        start: windowStart + 100 * MINUTE_MS,
        end: windowStart + 100 * MINUTE_MS,
      }
      const entries = [entry('a', 30)]

      const result = placeDay({
        entries,
        free: [zeroInterval1, validInterval, zeroInterval2],
        now: windowStart,
      })

      expect(result.scheduled[0]?.startsAt).toBe(validInterval.start)
    })
  })
})

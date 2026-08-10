/**
 * Capacity, which is the arithmetic spec 05 opens with:
 *
 *     capacity = workingWindow - busyTime - reserve
 *
 * Pure, so every criterion in the Capacity section is asserted without a calendar, a database
 * or a clock. Criteria 1 to 4 live here; the planner's use of the answer is next door.
 */
import { describe, expect, it } from 'vitest'
import {
  computeCapacity,
  consumesCapacity,
  freeIntervals,
  mergeIntervals,
  workingWindowFor,
  type Interval,
} from '../../src/domain/capacity.js'
import type { CalendarEventFacts } from '../../src/domain/calendar.js'

const LONDON = 'Europe/London'

/** A Monday, chosen so the default working days include it. */
const MONDAY = { year: 2026, month: 6, day: 8 }

/** 09:00 to 17:30, Monday to Friday: spec 05's defaults. */
const workingHours = { startMinute: 9 * 60, endMinute: 17 * 60 + 30, days: [1, 2, 3, 4, 5] }

function windowFor(date = MONDAY) {
  const window = workingWindowFor(date, LONDON, workingHours)
  if (window === null) throw new Error('expected a working window on this day')
  return window
}

/** An event that does consume capacity, so a test only says what it is varying. */
function anEvent(overrides: Partial<CalendarEventFacts> = {}): CalendarEventFacts {
  return {
    startsAt: 0,
    endsAt: 0,
    allDay: false,
    responseStatus: 'accepted',
    transparency: 'opaque',
    status: 'confirmed',
    ...overrides,
  }
}

/** An event at a wall-clock time on the working day, said in the words a diary uses. */
function meeting(from: string, to: string, overrides: Partial<CalendarEventFacts> = {}) {
  const window = windowFor()
  const atMinute = (text: string): number => {
    const [hour = '0', minute = '0'] = text.split(':')
    return window.start + (Number(hour) * 60 + Number(minute) - workingHours.startMinute) * 60_000
  }

  return anEvent({ startsAt: atMinute(from), endsAt: atMinute(to), ...overrides })
}

function capacityWith(events: readonly CalendarEventFacts[], reservePercent = 20) {
  return computeCapacity({
    window: windowFor(),
    events,
    reservePercent,
    countAllDayEvents: false,
  })
}

describe('the working window', () => {
  it('spans the configured local hours of a working day', () => {
    const window = windowFor()

    expect(new Date(window.start).toISOString()).toBe('2026-06-08T08:00:00.000Z')
    expect(new Date(window.end).toISOString()).toBe('2026-06-08T16:30:00.000Z')
  })

  /** Spec 06 criterion 4's rule, from the planner's side: the clock reading is what is fixed. */
  it('stays at the same wall-clock time across a DST boundary', () => {
    const winter = workingWindowFor({ year: 2026, month: 1, day: 5 }, LONDON, workingHours)

    expect(new Date(winter?.start ?? 0).toISOString()).toBe('2026-01-05T09:00:00.000Z')
  })

  it('is absent on a day the configuration does not call a working day', () => {
    expect(workingWindowFor({ year: 2026, month: 6, day: 7 }, LONDON, workingHours)).toBeNull()
  })
})

describe('which events consume capacity', () => {
  it('counts an accepted, opaque, timed event', () => {
    expect(consumesCapacity(anEvent(), { countAllDayEvents: false })).toBe(true)
  })

  /** Criterion 3, first half. */
  it('ignores an event marked free', () => {
    expect(
      consumesCapacity(anEvent({ transparency: 'transparent' }), { countAllDayEvents: false }),
    ).toBe(false)
  })

  /** Criterion 3, second half. */
  it('ignores a declined event', () => {
    expect(
      consumesCapacity(anEvent({ responseStatus: 'declined' }), { countAllDayEvents: false }),
    ).toBe(false)
  })

  /** Spec 05 counts unanswered invitations: an invitation you have not declined is still a claim. */
  it('counts an unanswered invitation', () => {
    expect(
      consumesCapacity(anEvent({ responseStatus: 'needsAction' }), { countAllDayEvents: false }),
    ).toBe(true)
  })

  it('ignores a cancelled event', () => {
    expect(consumesCapacity(anEvent({ status: 'cancelled' }), { countAllDayEvents: false })).toBe(
      false,
    )
  })

  it('ignores an all-day event unless it is configured to count', () => {
    const allDay = anEvent({ allDay: true })

    expect(consumesCapacity(allDay, { countAllDayEvents: false })).toBe(false)
    expect(consumesCapacity(allDay, { countAllDayEvents: true })).toBe(true)
  })
})

describe('merging busy intervals', () => {
  const at = (start: number, end: number): Interval => ({ start, end })

  it('joins two that overlap into one', () => {
    expect(mergeIntervals([at(0, 30), at(20, 50)])).toEqual([at(0, 50)])
  })

  it('joins two that touch, since no time is free between them', () => {
    expect(mergeIntervals([at(0, 30), at(30, 60)])).toEqual([at(0, 60)])
  })

  it('keeps two that do not meet apart', () => {
    expect(mergeIntervals([at(0, 30), at(40, 60)])).toEqual([at(0, 30), at(40, 60)])
  })

  it('swallows an interval wholly inside another', () => {
    expect(mergeIntervals([at(0, 60), at(10, 20)])).toEqual([at(0, 60)])
  })

  it('sorts what it is given, so the caller does not have to', () => {
    expect(mergeIntervals([at(40, 60), at(0, 30)])).toEqual([at(0, 30), at(40, 60)])
  })

  it('drops an interval with no length in it', () => {
    expect(mergeIntervals([at(10, 10)])).toEqual([])
  })
})

describe('computing the day', () => {
  const MINUTE = 60_000

  /** Criterion 1: an empty day is the window less the reserve, and nothing else. */
  it('gives the whole window less the reserve when nothing is booked', () => {
    const capacity = capacityWith([])

    expect(capacity.windowMinutes).toBe(510)
    expect(capacity.busyMinutes).toBe(0)
    expect(capacity.reserveMinutes).toBe(102)
    expect(capacity.capacityMinutes).toBe(408)
  })

  /** Criterion 2: overlapping meetings count once. */
  it('reduces capacity by the union of two overlapping meetings, not their sum', () => {
    const capacity = capacityWith([meeting('10:00', '11:00'), meeting('10:30', '11:30')])

    expect(capacity.busyMinutes).toBe(90)
    expect(capacity.capacityMinutes).toBe(510 - 90 - 102)
  })

  /** Criterion 3, through the whole calculation rather than the predicate alone. */
  it.each([
    ['free', { transparency: 'transparent' as const }],
    ['declined', { responseStatus: 'declined' as const }],
  ])('does not let a %s event reduce capacity', (_name, overrides) => {
    const capacity = capacityWith([meeting('10:00', '11:00', overrides)])

    expect(capacity.busyMinutes).toBe(0)
    expect(capacity.capacityMinutes).toBe(408)
  })

  /** Criterion 4: only the overlap counts. */
  it('counts only the part of an event that falls inside the window', () => {
    const capacity = capacityWith([meeting('08:00', '10:00')])

    expect(capacity.busyMinutes).toBe(60)
  })

  it('counts nothing for an event wholly outside the window', () => {
    const capacity = capacityWith([meeting('18:00', '19:00')])

    expect(capacity.busyMinutes).toBe(0)
  })

  it('clips the end of an event that runs past the window', () => {
    const capacity = capacityWith([meeting('17:00', '18:30')])

    expect(capacity.busyMinutes).toBe(30)
  })

  /** A day that is more meetings than window. The number is negative and says so. */
  it('reports a negative capacity rather than pretending the day is empty', () => {
    const capacity = capacityWith([meeting('09:00', '17:30')])

    expect(capacity.busyMinutes).toBe(510)
    expect(capacity.capacityMinutes).toBe(-102)
  })

  it('holds nothing back when the reserve is zero', () => {
    expect(capacityWith([], 0).capacityMinutes).toBe(510)
  })

  /** The dashboard's calendar column reads these, so they are part of the answer. */
  it('reports the busy blocks merged and clipped to the window', () => {
    const window = windowFor()
    const capacity = capacityWith([meeting('08:00', '10:00'), meeting('09:30', '11:00')])

    expect(capacity.busy).toEqual([{ start: window.start, end: window.start + 120 * MINUTE }])
  })

  it('reports the free blocks between them', () => {
    const window = windowFor()

    expect(
      freeIntervals(window, [{ start: window.start, end: window.start + 60 * MINUTE }]),
    ).toEqual([{ start: window.start + 60 * MINUTE, end: window.end }])
  })

  it('reports no free blocks on a day that is booked end to end', () => {
    const window = windowFor()

    expect(freeIntervals(window, [window])).toEqual([])
  })
})

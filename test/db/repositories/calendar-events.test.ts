/**
 * The calendar store. Events are kept for one reason: to work out how much of a day is
 * already spoken for (spec 05). They never become tasks, which spec 02 criterion 7 makes a
 * guarantee rather than a habit, so the table has no task column for one to be written to.
 */
import { describe, expect, it } from 'vitest'
import {
  countCalendarEvents,
  deleteCalendarEvent,
  listCalendarEvents,
  purgeUnseenCalendarEvents,
  upsertCalendarEvent,
  type CalendarEventInput,
} from '../../../src/db/repositories/calendar-events.js'
import { migratedDatabase } from '../../helpers/temp-database.js'

const NOW = Date.UTC(2026, 5, 8, 9, 0, 0)
const HOUR = 60 * 60_000

function anEvent(overrides: Partial<CalendarEventInput> = {}): CalendarEventInput {
  return {
    calendarId: 'primary',
    externalId: 'event-1',
    summary: 'Hub weekly',
    startsAt: NOW,
    endsAt: NOW + HOUR,
    allDay: false,
    responseStatus: 'accepted',
    transparency: 'opaque',
    status: 'confirmed',
    attendeeCount: 4,
    url: 'https://calendar.example.com/event-1',
    ...overrides,
  }
}

describe('storing an event', () => {
  it('reads back everything capacity turns on', () => {
    const database = migratedDatabase()

    const stored = upsertCalendarEvent(database, anEvent(), NOW)

    expect(stored).toMatchObject({
      calendarId: 'primary',
      externalId: 'event-1',
      summary: 'Hub weekly',
      startsAt: NOW,
      endsAt: NOW + HOUR,
      allDay: false,
      responseStatus: 'accepted',
      transparency: 'opaque',
      status: 'confirmed',
      attendeeCount: 4,
      syncedAt: NOW,
    })
  })

  /** A moved meeting is the same meeting. Keyed on the calendar and the provider's own id. */
  it('updates in place when the same event is seen again', () => {
    const database = migratedDatabase()
    upsertCalendarEvent(database, anEvent(), NOW)

    const moved = upsertCalendarEvent(
      database,
      anEvent({ startsAt: NOW + HOUR, endsAt: NOW + 2 * HOUR, responseStatus: 'declined' }),
      NOW + 60_000,
    )

    expect(countCalendarEvents(database)).toBe(1)
    expect(moved).toMatchObject({ startsAt: NOW + HOUR, responseStatus: 'declined' })
  })

  it('keeps the same id for two calendars using the same event id', () => {
    const database = migratedDatabase()

    upsertCalendarEvent(database, anEvent(), NOW)
    upsertCalendarEvent(database, anEvent({ calendarId: 'team' }), NOW)

    expect(countCalendarEvents(database)).toBe(2)
  })
})

describe('reading a range', () => {
  it('returns events that overlap it, ordered by when they start', () => {
    const database = migratedDatabase()
    upsertCalendarEvent(
      database,
      anEvent({ externalId: 'later', startsAt: NOW + 2 * HOUR, endsAt: NOW + 3 * HOUR }),
      NOW,
    )
    upsertCalendarEvent(database, anEvent({ externalId: 'earlier' }), NOW)

    const found = listCalendarEvents(database, { from: NOW, to: NOW + 4 * HOUR })

    expect(found.map((event) => event.externalId)).toEqual(['earlier', 'later'])
  })

  /** An event that started before the range and runs into it is part of the day. */
  it('includes an event that straddles the start of the range', () => {
    const database = migratedDatabase()
    upsertCalendarEvent(database, anEvent({ startsAt: NOW - HOUR, endsAt: NOW + HOUR }), NOW)

    expect(listCalendarEvents(database, { from: NOW, to: NOW + HOUR })).toHaveLength(1)
  })

  it('leaves out one that ends before the range opens', () => {
    const database = migratedDatabase()
    upsertCalendarEvent(database, anEvent({ startsAt: NOW - 2 * HOUR, endsAt: NOW - HOUR }), NOW)

    expect(listCalendarEvents(database, { from: NOW, to: NOW + HOUR })).toEqual([])
  })

  it('leaves out one that starts after it closes', () => {
    const database = migratedDatabase()
    upsertCalendarEvent(
      database,
      anEvent({ startsAt: NOW + 5 * HOUR, endsAt: NOW + 6 * HOUR }),
      NOW,
    )

    expect(listCalendarEvents(database, { from: NOW, to: NOW + HOUR })).toEqual([])
  })
})

/**
 * The window is a rolling one, and an event deleted upstream simply stops being returned. So a
 * pass sweeps up whatever it did not see, rather than leaving a meeting on the dashboard that
 * was cancelled a week ago.
 */
describe('sweeping up what a pass did not see', () => {
  it('deletes an event in the window that this pass did not touch', () => {
    const database = migratedDatabase()
    upsertCalendarEvent(database, anEvent({ externalId: 'gone' }), NOW - 60_000)
    upsertCalendarEvent(database, anEvent({ externalId: 'still-there' }), NOW)

    const swept = purgeUnseenCalendarEvents(database, {
      calendarId: 'primary',
      from: NOW - HOUR,
      to: NOW + HOUR,
      syncedBefore: NOW,
    })

    expect(swept).toBe(1)
    expect(
      listCalendarEvents(database, { from: NOW - HOUR, to: NOW + HOUR }).map((e) => e.externalId),
    ).toEqual(['still-there'])
  })

  it('leaves another calendar’s events alone', () => {
    const database = migratedDatabase()
    upsertCalendarEvent(database, anEvent({ calendarId: 'team' }), NOW - 60_000)

    const swept = purgeUnseenCalendarEvents(database, {
      calendarId: 'primary',
      from: NOW - HOUR,
      to: NOW + HOUR,
      syncedBefore: NOW,
    })

    expect(swept).toBe(0)
  })

  it('leaves events outside the window alone, since the pass never looked there', () => {
    const database = migratedDatabase()
    upsertCalendarEvent(
      database,
      anEvent({
        externalId: 'next-month',
        startsAt: NOW + 30 * 24 * HOUR,
        endsAt: NOW + 30 * 24 * HOUR + HOUR,
      }),
      NOW - 60_000,
    )

    const swept = purgeUnseenCalendarEvents(database, {
      calendarId: 'primary',
      from: NOW - HOUR,
      to: NOW + HOUR,
      syncedBefore: NOW,
    })

    expect(swept).toBe(0)
  })
})

describe('deleting one outright', () => {
  it('removes a cancelled event and says it did', () => {
    const database = migratedDatabase()
    upsertCalendarEvent(database, anEvent(), NOW)

    expect(deleteCalendarEvent(database, 'primary', 'event-1')).toBe(true)
    expect(countCalendarEvents(database)).toBe(0)
  })

  it('says so when there was nothing to delete', () => {
    expect(deleteCalendarEvent(migratedDatabase(), 'primary', 'never-seen')).toBe(false)
  })
})

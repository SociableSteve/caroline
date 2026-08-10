/**
 * Turning what Google returns into what capacity is computed from, against a recorded payload.
 * Spec 02 criterion 8: no network anywhere in the suite.
 *
 * The mapping is where spec 02's "declined events and events marked as free do not consume
 * capacity" becomes a fact in a row rather than a sentence in a document.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { toCalendarEventInput, type GoogleCalendarEvent } from '../../../src/connectors/gcal/map.js'

const LONDON = 'Europe/London'

function recordedEvents(): GoogleCalendarEvent[] {
  const path = fileURLToPath(new URL('../../fixtures/gcal/primary-week.json', import.meta.url))
  return (JSON.parse(readFileSync(path, 'utf8')) as { items: GoogleCalendarEvent[] }).items
}

function mapped(id: string) {
  const raw = recordedEvents().find((event) => event.id === id)
  if (raw === undefined) throw new Error(`No recorded event ${id}`)

  return toCalendarEventInput(raw, 'primary', LONDON)
}

describe('a timed event you accepted', () => {
  const event = mapped('event-standup')

  it('carries the calendar, the id and the summary', () => {
    expect(event).toMatchObject({
      calendarId: 'primary',
      externalId: 'event-standup',
      summary: 'Team standup',
      url: 'https://calendar.example.com/event?eid=event-standup',
    })
  })

  it('resolves the offset Google sent rather than assuming UTC', () => {
    expect(new Date(event?.startsAt ?? 0).toISOString()).toBe('2026-06-08T08:30:00.000Z')
    expect(new Date(event?.endsAt ?? 0).toISOString()).toBe('2026-06-08T08:45:00.000Z')
  })

  it('reads your own response rather than the organiser’s', () => {
    expect(event).toMatchObject({ responseStatus: 'accepted', transparency: 'opaque' })
  })

  it('counts the attendees', () => {
    expect(event?.attendeeCount).toBe(2)
  })
})

describe('the cases that do not take time off the day', () => {
  it('keeps an event you marked free, labelled as free', () => {
    expect(mapped('event-focus')).toMatchObject({
      externalId: 'event-focus',
      transparency: 'transparent',
    })
  })

  it('keeps one you declined, labelled as declined', () => {
    expect(mapped('event-vendor-call')).toMatchObject({ responseStatus: 'declined' })
  })

  it('keeps a cancelled one, labelled as cancelled', () => {
    expect(mapped('event-cancelled')).toMatchObject({ status: 'cancelled' })
  })
})

describe('an event with no attendees on it', () => {
  /**
   * A meeting you put in your own diary has no attendee list to find yourself in. It is yours,
   * so it is accepted: treating it as unanswered would be true of the data and wrong about the day.
   */
  it('is accepted, since nobody had to invite you to it', () => {
    expect(mapped('event-focus')?.responseStatus).toBe('accepted')
  })

  it('is unanswered when you were invited and have not said', () => {
    expect(mapped('event-invite-unanswered')?.responseStatus).toBe('needsAction')
  })
})

describe('an all-day event', () => {
  const event = mapped('event-bank-holiday')

  it('is marked as one', () => {
    expect(event?.allDay).toBe(true)
  })

  /** Dated in the local zone, so a holiday does not land on the day before in a western one. */
  it('spans local midnight to local midnight', () => {
    expect(new Date(event?.startsAt ?? 0).toISOString()).toBe('2026-06-08T23:00:00.000Z')
    expect(new Date(event?.endsAt ?? 0).toISOString()).toBe('2026-06-09T23:00:00.000Z')
  })
})

describe('what cannot be mapped', () => {
  it('refuses an event with no id, which nothing could be keyed by', () => {
    expect(
      toCalendarEventInput({ start: { dateTime: '2026-06-08T09:00:00Z' } }, 'primary', LONDON),
    ).toBeNull()
  })

  it('refuses one with no start', () => {
    expect(toCalendarEventInput({ id: 'event-1' }, 'primary', LONDON)).toBeNull()
  })

  it('refuses one whose times will not parse', () => {
    expect(
      toCalendarEventInput(
        { id: 'event-1', start: { dateTime: 'soon' }, end: { dateTime: 'later' } },
        'primary',
        LONDON,
      ),
    ).toBeNull()
  })

  /** An end before its start would subtract from the busy total. */
  it('refuses one that ends before it starts', () => {
    expect(
      toCalendarEventInput(
        {
          id: 'event-1',
          start: { dateTime: '2026-06-08T10:00:00Z' },
          end: { dateTime: '2026-06-08T09:00:00Z' },
        },
        'primary',
        LONDON,
      ),
    ).toBeNull()
  })

  /** A response Google has not used before is not a reason to lose the event off the diary. */
  it('treats an unrecognised response as unanswered rather than dropping the event', () => {
    const event = toCalendarEventInput(
      {
        id: 'event-1',
        start: { dateTime: '2026-06-08T09:00:00Z' },
        end: { dateTime: '2026-06-08T10:00:00Z' },
        attendees: [{ self: true, responseStatus: 'maybe-later' }],
      },
      'primary',
      LONDON,
    )

    expect(event?.responseStatus).toBe('needsAction')
  })
})

/**
 * What Google returns, turned into what capacity is computed from. Spec 02's "metadata
 * retained" list for the calendar, and no more: id, summary, start, end, all-day flag,
 * response status, transparency, attendee count and calendar id.
 *
 * There is deliberately no description, no location and no attendee list. An event's body is
 * not content Caroline needs, so it is not content Caroline holds: spec 09's storage policy is
 * about what a connector fetches as much as what it keeps, and the cheapest way to honour it
 * for the calendar is never to map the fields at all.
 */
import {
  calendarResponseStatuses,
  type CalendarEventStatus,
  type CalendarResponseStatus,
} from '../../domain/calendar.js'
import { instantAt, parseLocalDate } from '../../domain/time.js'
import type { CalendarEventInput } from '../../db/repositories/calendar-events.js'

/** An event as Google returns it, reduced to the fields Caroline reads. */
export interface GoogleCalendarEvent {
  readonly id?: string
  readonly status?: string
  readonly summary?: string
  readonly htmlLink?: string
  readonly transparency?: string
  readonly start?: GoogleEventTime
  readonly end?: GoogleEventTime
  readonly attendees?: readonly GoogleAttendee[]
  readonly organizer?: { readonly self?: boolean }
}

export interface GoogleEventTime {
  /** Present on a timed event, with an offset in it. */
  readonly dateTime?: string
  /** Present on an all-day event instead, as `YYYY-MM-DD`. The end is exclusive. */
  readonly date?: string
}

export interface GoogleAttendee {
  readonly self?: boolean
  readonly responseStatus?: string
  /** A room, not a person. Counted like any other attendee, and never mistaken for you. */
  readonly resource?: boolean
}

const eventStatuses: readonly string[] = ['confirmed', 'tentative', 'cancelled']

/**
 * The instant a start or end names, or null when it names nothing usable.
 *
 * An all-day date has no time and no offset in it, so it is resolved as local midnight in the
 * configured zone. Read as UTC instead, a holiday would land on the day before for anyone west
 * of Greenwich, and the day it takes off the diary would be the wrong day.
 */
function instantOf(time: GoogleEventTime | undefined, timeZone: string): number | null {
  if (time === undefined) return null

  if (typeof time.dateTime === 'string') {
    const parsed = Date.parse(time.dateTime)
    return Number.isNaN(parsed) ? null : parsed
  }

  if (typeof time.date !== 'string') return null

  const date = parseLocalDate(time.date)
  return date === null ? null : instantAt(date, 0, timeZone)
}

/**
 * Your own answer to the invitation, which is what decides whether the time is yours. An event
 * with no attendee marked `self` is one you put in your own diary, so it is accepted: nobody
 * had to invite you to it, and treating it as unanswered would be true of the data and wrong
 * about the day.
 *
 * A response Google has not used before is read as unanswered rather than dropping the event:
 * an unrecognised word is a reason to be careful with the time, not to pretend it is free.
 */
function responseOf(event: GoogleCalendarEvent): CalendarResponseStatus {
  const mine = event.attendees?.find((attendee) => attendee.self === true)
  if (mine === undefined) return 'accepted'

  const answer = mine.responseStatus
  return (calendarResponseStatuses as readonly string[]).includes(answer ?? '')
    ? (answer as CalendarResponseStatus)
    : 'needsAction'
}

/**
 * One event, or null when it is not one Caroline can use. Null rather than a throw: one
 * unmappable event in a fortnight should cost that event, not the whole pass and with it the
 * capacity every other meeting would have contributed.
 */
export function toCalendarEventInput(
  event: GoogleCalendarEvent,
  calendarId: string,
  timeZone: string,
): CalendarEventInput | null {
  if (typeof event.id !== 'string' || event.id === '') return null

  const allDay = typeof event.start?.date === 'string'
  const startsAt = instantOf(event.start, timeZone)
  const endsAt = instantOf(event.end, timeZone)

  if (startsAt === null || endsAt === null) return null
  // An event ending before it starts would subtract from the busy total. The schema refuses it
  // too; refusing it here is what keeps a whole pass from failing on one malformed row.
  if (endsAt < startsAt) return null

  return {
    calendarId,
    externalId: event.id,
    summary: typeof event.summary === 'string' && event.summary !== '' ? event.summary : null,
    startsAt,
    endsAt,
    allDay,
    responseStatus: responseOf(event),
    // Anything Google does not call transparent shows you as busy, including the common case
    // of the field being absent altogether.
    transparency: event.transparency === 'transparent' ? 'transparent' : 'opaque',
    status: eventStatuses.includes(event.status ?? '')
      ? (event.status as CalendarEventStatus)
      : 'confirmed',
    attendeeCount: event.attendees?.length ?? 0,
    url: typeof event.htmlLink === 'string' && event.htmlLink !== '' ? event.htmlLink : null,
  }
}

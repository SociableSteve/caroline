/**
 * A calendar event, as Caroline keeps one. It exists to say how much of a day is already
 * spoken for (spec 05) and to render the dashboard's calendar column (spec 08), and for
 * nothing else: an event never becomes a task, in any code path. Spec 02, criterion 7.
 *
 * Google's own vocabulary is kept rather than mapped into words of Caroline's, because every
 * one of these values is a fact the provider reported and renaming them would only add a
 * translation table for a reader of the database to look through.
 */

export const calendarResponseStatuses = [
  'accepted',
  'tentative',
  'declined',
  'needsAction',
] as const
/** Yours, not the organiser's. Declining is what releases the time. */
export type CalendarResponseStatus = (typeof calendarResponseStatuses)[number]

export const calendarTransparencies = ['opaque', 'transparent'] as const
/** `transparent` is Google's word for "does not show me as busy". */
export type CalendarTransparency = (typeof calendarTransparencies)[number]

export const calendarEventStatuses = ['confirmed', 'tentative', 'cancelled'] as const
export type CalendarEventStatus = (typeof calendarEventStatuses)[number]

/** The part of an event that decides whether it takes time off your day. */
export interface CalendarEventFacts {
  readonly startsAt: number
  readonly endsAt: number
  readonly allDay: boolean
  readonly responseStatus: CalendarResponseStatus
  readonly transparency: CalendarTransparency
  readonly status: CalendarEventStatus
}

export interface CalendarEvent extends CalendarEventFacts {
  readonly id: string
  readonly calendarId: string
  /** The provider's own id. Unique with `calendarId`, and the store's dedupe key. */
  readonly externalId: string
  readonly summary: string | null
  readonly attendeeCount: number
  readonly url: string | null
  /** Which pass last saw it, so a pass can sweep up what has been cancelled upstream. */
  readonly syncedAt: number
}

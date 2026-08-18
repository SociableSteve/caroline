/**
 * The daily plan and the calendar behind it. Spec 08's route table, specs 05 and 02.
 *
 * Both routes answer for a local calendar date, defaulting to today, and both compute capacity
 * through `src/actions/capacity.ts`, as the planner and chat's `get_capacity` tool do. That is what
 * makes spec 08 criterion 6 true rather than merely intended: the capacity bar and
 * `GET /api/calendar` are not two answers that agree, they are one answer read twice.
 */
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Config } from '../../config/schema.js'
import type { Database } from '../../db/index.js'
import { listCalendarEvents } from '../../db/repositories/calendar-events.js'
import { latestDailyPlan, planHistory } from '../../db/repositories/daily-plans.js'
import { capacityFrom, dayBounds, workingWindowForDate } from '../../actions/capacity.js'
import type { CalendarEvent } from '../../domain/calendar.js'
import { consumesCapacity } from '../../domain/capacity.js'
import {
  addDays,
  formatLocalDate,
  localDateAt,
  parseLocalDate,
  type LocalDate,
} from '../../domain/time.js'
import type { CarolineJobs } from '../../jobs/registry.js'
import { PLAN_JOB } from '../../jobs/plan.js'
import { apiError } from '../errors.js'
import {
  calendarQuerySchema,
  calendarResponseSchema,
  planDayResponseSchema,
  planParamsSchema,
} from '../schemas.js'

export interface PlanRouteContext {
  readonly config: Config
  readonly database: Database
  readonly jobs: CarolineJobs
  readonly now: () => number
}

/** How many days of planned-against-completed the dashboard draws. Spec 05. */
export const HISTORY_DAYS = 14

/**
 * The date a request is about. The schema has already checked the shape, so the only thing
 * left to refuse is a shape that is not a date: `2026-02-30` passes a pattern and names no day.
 */
function dateFrom(raw: string | undefined, timeZone: string, now: number): LocalDate | null {
  if (raw === undefined) return localDateAt(now, timeZone)
  return parseLocalDate(raw)
}

function badDate(reply: FastifyReply, raw: string): FastifyReply {
  return reply
    .status(400)
    .send(
      apiError('bad_request', `"${raw}" is not a date. Use YYYY-MM-DD, or leave it off for today.`),
    )
}

export function registerPlanRoutes(
  app: FastifyInstance,
  { config, database, jobs, now }: PlanRouteContext,
): void {
  const timeZone = config.jobs.timezone

  /** The plan for a date, with the fortnight the dashboard draws beside it. */
  const answerFor = (date: LocalDate) => {
    const planDate = formatLocalDate(date)
    // Calendar days, not elapsed hours: subtracting fourteen times twenty-four hours from a
    // local midnight lands a day early across a spring-forward, and the fortnight would quietly
    // become fifteen days once a year.
    const from = formatLocalDate(addDays(date, -HISTORY_DAYS))

    return {
      date: planDate,
      plan: latestDailyPlan(database, planDate),
      history: planHistory(database, { from, to: planDate }),
    }
  }

  const planRoute = {
    schema: { params: planParamsSchema, response: { 200: planDayResponseSchema } },
  }

  const handlePlan = (raw: string | undefined, reply: FastifyReply) => {
    const date = dateFrom(raw, timeZone, now())
    // A plan for a day that does not exist is not something to answer with an empty state:
    // nothing could ever have been planned for it, so the request is the mistake.
    if (date === null) return badDate(reply, raw ?? '')

    return answerFor(date)
  }

  app.get<{ Params: { date: string } }>('/api/plan/:date', planRoute, async (request, reply) =>
    handlePlan(request.params.date, reply),
  )

  // Registered separately rather than as an optional parameter, so the schema for the one with
  // a date in it can require the date rather than merely describe it.
  app.get(
    '/api/plan',
    {
      schema: {
        querystring: { type: 'object', additionalProperties: false, properties: {} },
        response: { 200: planDayResponseSchema },
      },
    },
    async (_request, reply) => handlePlan(undefined, reply),
  )

  /**
   * Regenerating. Today only: yesterday's plan is a record of what was proposed yesterday, and
   * redrawing it against today's tasks would rewrite that record and the fortnight of planned
   * against completed with it. Spec 05 keeps the previous plan for the *same* day in history,
   * which is a different thing from rewriting a different day.
   *
   * It goes through the scheduler, so a regenerate is recorded and guarded against overlap
   * exactly as a scheduled run is. Spec 06: manual runs are first-class and take the same path.
   */
  app.post<{ Params: { date: string } }>(
    '/api/plan/:date/regenerate',
    {
      schema: { params: planParamsSchema, response: { 200: planDayResponseSchema } },
    },
    async (request, reply) => {
      const date = dateFrom(request.params.date, timeZone, now())
      if (date === null) return badDate(reply, request.params.date)

      const today = localDateAt(now(), timeZone)
      if (formatLocalDate(date) !== formatLocalDate(today)) {
        return reply
          .status(400)
          .send(
            apiError(
              'bad_request',
              `Only today's plan can be regenerated. ${formatLocalDate(date)} is history, and redrawing it would rewrite what was proposed on the day.`,
            ),
          )
      }

      const outcome = await jobs.scheduler.run(PLAN_JOB, 'manual')

      if (outcome.status === 'already-running') {
        return reply
          .status(409)
          .send(
            apiError(
              'already_running',
              'The planner is already running. Wait for it to finish, then reload.',
            ),
          )
      }

      // Nothing is published here: the scheduler announces every run it records, whichever
      // trigger asked for it, so a second announcement would only reload the open tabs twice.
      return answerFor(date)
    },
  )

  /**
   * The day's events and its capacity. The events are the whole local day, because the column
   * draws a diary rather than a working window; the capacity is the working window, because
   * that is the only part of the day there is any work to plan into.
   */
  app.get<{ Querystring: { date?: string } }>(
    '/api/calendar',
    {
      schema: { querystring: calendarQuerySchema, response: { 200: calendarResponseSchema } },
    },
    async (request, reply) => {
      const date = dateFrom(request.query.date, timeZone, now())
      if (date === null) return badDate(reply, request.query.date ?? '')

      const connected = jobs.calendarConnected()
      const bounds = dayBounds(date, timeZone)
      // Whatever is stored, connected or not. A row in `calendar_events` is a meeting that was
      // really in the diary, so there is nothing to filter out here. Disconnecting the account
      // clears them, but a calendar can stop being readable without that path being taken (the
      // client secret cleared, the integration disabled), which leaves the rows behind: events
      // under an unverified capacity are a real case rather than a bug, and
      // `unverifiedCapacityNotice` is what tells the reader which of the two they are looking at.
      const events = listCalendarEvents(database, { from: bounds.start, to: bounds.end })

      // The events of the whole day, but the capacity of the working window: the column draws a
      // diary, and the window is the only part of the day there is work to plan into. Both come
      // from the one computation in `src/actions/capacity.ts`, which is what makes spec 08
      // criterion 6 true rather than merely intended.
      return {
        date: formatLocalDate(date),
        connected,
        events: events.map((event) => toEventResponse(event, config)),
        // The day's events, not the window's: `computeCapacity` clips to the window itself, so
        // an evening meeting takes nothing off the working day either way.
        capacity: capacityFrom(workingWindowForDate(config, date), events, config, connected),
      }
    },
  )
}

function toEventResponse(event: CalendarEvent, config: Config) {
  return {
    id: event.id,
    calendarId: event.calendarId,
    summary: event.summary,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    allDay: event.allDay,
    responseStatus: event.responseStatus,
    transparency: event.transparency,
    status: event.status,
    attendeeCount: event.attendeeCount,
    url: event.url,
    // Said on the event rather than left to the reader: a declined meeting still appears in the
    // column, and the column should be able to show why it took nothing off the day.
    consumesCapacity: consumesCapacity(event, {
      countAllDayEvents: config.planning.countAllDayEvents,
    }),
  }
}

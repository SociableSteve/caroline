/**
 * The tools that only answer questions. Spec 07: task detail is fetched through these rather
 * than dumped into the prompt, so the context stays small and the model reads current data.
 *
 * None of them reaches an external system, which is criterion 2 and is a property of what they
 * import: the repositories and the domain, and nothing from `src/connectors`.
 *
 * Instants are answered as ISO 8601 strings alongside their epoch value. A model reasons about
 * "2026-06-12T09:00:00.000Z" and cannot reliably do arithmetic on 1781254800000, and the epoch
 * is kept beside it because that is what a later tool call has to pass back.
 */
import { capacityForDate } from '../../actions/capacity.js'
import { textToSend } from '../../config/content.js'
import { waitingItemsFor } from '../../actions/waiting.js'
import { listCalendarEvents } from '../../db/repositories/calendar-events.js'
import { listClassifications } from '../../db/repositories/classifications.js'
import { latestDailyPlan } from '../../db/repositories/daily-plans.js'
import {
  getProjectNextAction,
  listProjects,
  listStalledProjects,
} from '../../db/repositories/projects.js'
import { listSourcesForTask } from '../../db/repositories/sources.js'
import { getTask, getTaskTags, listTasks } from '../../db/repositories/tasks.js'
import { consumesCapacity } from '../../domain/capacity.js'
import { projectStates, type ProjectState } from '../../domain/project.js'
import type { Source } from '../../domain/source.js'
import { taskStatuses, type TaskStatus } from '../../domain/task.js'
import { isStaleWait } from '../../domain/waiting.js'
import { defineTool, type ChatTool } from '../types.js'
import { asIso, dateFrom, describeDuration, MAX_ROWS, taskSummary } from './shared.js'

interface SearchArguments {
  readonly query?: string
  readonly status?: readonly TaskStatus[]
  readonly projectId?: string
  readonly dueBefore?: string
  readonly limit?: number
  readonly includeDeferred?: boolean
}

const searchTasks = defineTool<SearchArguments>({
  name: 'search_tasks',
  kind: 'read',
  description:
    'Find tasks. Every filter is optional and they combine: query is a case-insensitive substring of the title or notes, status is one or more GTD statuses, dueBefore is a local date (YYYY-MM-DD) and matches tasks due on or before the end of it. Returns the newest page of matches and the total number of them.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      query: { type: 'string', maxLength: 200 },
      status: { type: 'array', items: { type: 'string', enum: taskStatuses }, maxItems: 7 },
      projectId: { type: 'string', maxLength: 64 },
      dueBefore: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      limit: { type: 'integer', minimum: 1, maximum: MAX_ROWS },
      includeDeferred: { type: 'boolean' },
    },
  },
  execute(context, args) {
    const dueBefore = args.dueBefore === undefined ? null : dateFrom(context, args.dueBefore)
    if (args.dueBefore !== undefined && dueBefore === null) {
      return { ok: false, message: `"${args.dueBefore}" is not a date. Use YYYY-MM-DD.` }
    }

    const page = listTasks(
      context.database,
      {
        ...(args.query === undefined ? {} : { search: args.query }),
        ...(args.status === undefined ? {} : { status: args.status }),
        ...(args.projectId === undefined ? {} : { projectId: args.projectId }),
        ...(dueBefore === null ? {} : { dueBefore: dueBefore.endOfDay }),
        ...(args.includeDeferred === undefined ? {} : { includeDeferred: args.includeDeferred }),
        limit: args.limit ?? 20,
      },
      context.now,
    )

    return {
      ok: true,
      data: {
        total: page.total,
        returned: page.tasks.length,
        tasks: page.tasks.map((task) => taskSummary(context, task)),
      },
    }
  },
})

const getTaskTool = defineTool<{ readonly id: string }>({
  name: 'get_task',
  kind: 'read',
  description:
    'Everything known about one task: its fields, its tags, where it came from with a link out, and what the classifier has said about it.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: { id: { type: 'string', maxLength: 64 } },
  },
  execute(context, args) {
    const task = getTask(context.database, args.id)
    if (task === null) return { ok: false, message: `There is no task with the id ${args.id}.` }

    // Notes are the body-shaped field of a task, so they leave the machine only as far as `llmContent`
    // allows, through the same function the item context uses. Two answers to whether a note may be
    // sent would mean the policy is decoration. Spec 09.
    const notes = textToSend(task.notes, context.config.privacy)

    return {
      ok: true,
      data: {
        ...taskSummary(context, task),
        notes: notes.text,
        // Said rather than left to be inferred: a model shown three hundred characters and told
        // nothing would answer as though that were the whole note.
        ...(notes.truncated ? { notesTruncated: true } : {}),
        statusSetBy: task.statusSetBy,
        statusSetAt: asIso(task.statusSetAt),
        syncTracked: task.syncTracked,
        createdAt: asIso(task.createdAt),
        completedAt: asIso(task.completedAt),
        tags: getTaskTags(context.database, task.id),
        sources: listSourcesForTask(context.database, task.id).map(sourceSummary),
        // Newest first, as the audit trail is read. The stored body is not among the fields: the
        // content policy decides what a model is sent, and it is not this tool's to reopen.
        classifications: listClassifications(context.database, { taskId: task.id, limit: 10 }).map(
          (classification) => ({
            proposedStatus: classification.proposedStatus,
            confidence: classification.confidence,
            reasoning: classification.reasoning,
            applied: classification.applied,
            acceptedAt: asIso(classification.acceptedAt),
            dismissedAt: asIso(classification.dismissedAt),
            error: classification.error,
            at: asIso(classification.createdAt),
          }),
        ),
      },
    }
  },
})

function sourceSummary(source: Source) {
  return {
    provider: source.provider,
    externalId: source.externalId,
    title: source.title,
    url: source.url,
    lifecycleState: source.lifecycleState,
    actedAt: asIso(source.actedAt),
    resolvedAt: asIso(source.resolvedAt),
    // Why an email might be listed against a pull request: it is the notification about it, kept as
    // provenance rather than as work of its own. Spec 02.
    suppressedAt: asIso(source.suppressedAt),
  }
}

const listProjectsTool = defineTool<{ readonly state?: ProjectState }>({
  name: 'list_projects',
  kind: 'read',
  description:
    'The projects, with the next action each one derives from its tasks and whether it is stalled: active with nothing to do next.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: { state: { type: 'string', enum: projectStates } },
  },
  execute(context, args) {
    // The stalled set is computed over the active projects whatever the filter is, so asking for
    // one state cannot change what stalled means.
    const stalled = new Set(listStalledProjects(context.database).map((project) => project.id))

    return {
      ok: true,
      data: {
        projects: listProjects(context.database, args.state).map((project) => {
          const nextAction = getProjectNextAction(context.database, project.id)

          return {
            id: project.id,
            title: project.title,
            state: project.state,
            notes: project.notes,
            stalled: stalled.has(project.id),
            nextAction: nextAction === null ? null : { id: nextAction.id, title: nextAction.title },
          }
        }),
      },
    }
  },
})

const getDailyPlan = defineTool<{ readonly date?: string }>({
  name: 'get_daily_plan',
  kind: 'read',
  description:
    'The plan for a day, defaulting to today: what was planned in order and why, what did not fit, and who is being chased. A plan is a proposal, not a commitment, and it is only as current as the moment it was drawn.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: { date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } },
  },
  execute(context, args) {
    const date = dateFrom(context, args.date)
    if (date === null)
      return { ok: false, message: `"${args.date}" is not a date. Use YYYY-MM-DD.` }

    const plan = latestDailyPlan(context.database, date.text)
    if (plan === null) {
      return { ok: true, data: { date: date.text, plan: null, note: 'No plan has been drawn.' } }
    }

    const entry = (item: {
      rank: number
      taskId: string | null
      title: string
      rationale: string | null
      estimateMinutes: number | null
      done: boolean
    }) => ({
      rank: item.rank,
      taskId: item.taskId,
      title: item.title,
      rationale: item.rationale,
      estimateMinutes: item.estimateMinutes,
      done: item.done,
    })

    return {
      ok: true,
      data: {
        date: plan.planDate,
        generatedAt: asIso(plan.generatedAt),
        capacityMinutes: plan.capacityMinutes,
        capacityVerified: plan.capacityVerified,
        summary: plan.summary,
        warnings: plan.warnings,
        planned: plan.entries.map(entry),
        overflow: plan.overflow.map(entry),
        chases: plan.nudges.map((nudge) => ({
          rank: nudge.rank,
          taskId: nudge.taskId,
          title: nudge.title,
          waitingOn: nudge.waitingOn,
          waitingSince: asIso(nudge.waitingSince),
        })),
      },
    }
  },
})

const getCapacity = defineTool<{ readonly date?: string }>({
  name: 'get_capacity',
  kind: 'read',
  description:
    'How much free working time a day has, defaulting to today: the working window, the time the calendar has taken out of it, the reserve held back for interruptions, and what is left. Unverified means no calendar could be read, so the window was assumed free.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: { date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } },
  },
  execute(context, args) {
    const date = dateFrom(context, args.date)
    if (date === null)
      return { ok: false, message: `"${args.date}" is not a date. Use YYYY-MM-DD.` }

    const connected = context.calendarConnected()
    const capacity = capacityForDate(context.database, context.config, date.date, connected)
    const events = listCalendarEvents(context.database, {
      from: date.startOfDay,
      to: date.endOfDay,
    })

    return {
      ok: true,
      data: {
        date: date.text,
        workingDay: capacity.workingDay,
        windowMinutes: capacity.windowMinutes,
        busyMinutes: capacity.busyMinutes,
        reserveMinutes: capacity.reserveMinutes,
        capacityMinutes: capacity.capacityMinutes,
        capacity: describeDuration(capacity.capacityMinutes),
        verified: capacity.verified,
        events: events.map((event) => ({
          summary: event.summary,
          startsAt: asIso(event.startsAt),
          endsAt: asIso(event.endsAt),
          allDay: event.allDay,
          responseStatus: event.responseStatus,
          consumesCapacity: consumesCapacity(event, {
            countAllDayEvents: context.config.planning.countAllDayEvents,
          }),
        })),
      },
    }
  },
})

const listWaiting = defineTool<{ readonly staleOnly?: boolean }>({
  name: 'list_waiting',
  kind: 'read',
  description:
    'What is outstanding on somebody else: the item, who it is on, how long it has been waiting, and whether that is past the staleness threshold. For a pull request it also says whether the author has pushed anything since the review.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: { staleOnly: { type: 'boolean' } },
  },
  execute(context, args) {
    const { waitingStaleDays } = context.config.tasks
    const tasks = listTasks(context.database, { status: ['waiting'] }, context.now).tasks

    const items = waitingItemsFor(context.database, tasks)
      // Oldest first, which is the order a chase list is worked through. Spec 08. Sorted on the
      // instant rather than on the text of it, so the comparison is arithmetic.
      .toSorted((first, second) => first.waitingSince - second.waitingSince)
      .map((item) => ({
        taskId: item.taskId,
        title: item.title,
        waitingOn: item.waitingOn,
        waitingSince: asIso(item.waitingSince),
        waitingFor: describeDuration(Math.round((context.now - item.waitingSince) / 60_000)),
        stale: isStaleWait({ statusSetAt: item.waitingSince }, null, context.now, waitingStaleDays),
        isPullRequest: item.isPullRequest,
        pushedSinceReview: item.pushedSinceReview,
      }))

    return {
      ok: true,
      data: {
        staleAfterDays: waitingStaleDays,
        items: args.staleOnly === true ? items.filter((item) => item.stale) : items,
      },
    }
  },
})

/** Every read tool, in the order spec 07 lists them. */
export const readTools: readonly ChatTool[] = [
  searchTasks,
  getTaskTool,
  listProjectsTool,
  getDailyPlan,
  getCapacity,
  listWaiting,
]

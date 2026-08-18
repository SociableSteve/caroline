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
import { textToSend, WITHHELD_EVENT_TEXT, WITHHELD_ITEM_TEXT } from '../../config/content.js'
import { waitingItemsFor } from '../../actions/waiting.js'
import { listCalendarEvents } from '../../db/repositories/calendar-events.js'
import { listClassifications } from '../../db/repositories/classifications.js'
import { latestDailyPlan } from '../../db/repositories/daily-plans.js'
import {
  getProjectNextAction,
  listProjects,
  listStalledProjects,
} from '../../db/repositories/projects.js'
import { listSourcesForTask, listSourcesForTasks } from '../../db/repositories/sources.js'
import { getTask, getTaskTags, listTasks } from '../../db/repositories/tasks.js'
import { consumesCapacity } from '../../domain/capacity.js'
import { projectStates, type ProjectState } from '../../domain/project.js'
import type { Source } from '../../domain/source.js'
import { taskStatuses, type Task, type TaskStatus } from '../../domain/task.js'
import { isStaleWait } from '../../domain/waiting.js'
import { defineTool, type ChatTool } from '../types.js'
import {
  asIso,
  dateFrom,
  describeDuration,
  MAX_ROWS,
  taskSummary,
  withheldItem,
  withholdsText,
} from './shared.js'

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

    // A page of summaries is a page of titles, so it is held to the level one title is held to: at
    // `none` the ids go and the withholding is stated, as in `get_task` and in the item context. The
    // count of matches is not an item's content and still goes. Spec 09, criterion 13.
    if (withholdsText(context)) {
      return {
        ok: true,
        data: {
          total: page.total,
          returned: page.tasks.length,
          tasks: page.tasks.map((task) => ({ kind: 'task', id: task.id })),
          withheld: WITHHELD_ITEM_TEXT,
        },
      }
    }

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

    // At `none` nothing about a task goes but its kind and its id, exactly as in the item context:
    // spec 07 has the tool and the context answered by one policy, so a level that withholds a title
    // from the one cannot hand it over from the other. Spec 09, criterion 13. The withholding is
    // stated, so the model asks rather than answering about a task it was not shown.
    if (withholdsText(context)) {
      return { ok: true, data: withheldItem('task', task.id) }
    }

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
    // A project's title is content as a task's is, and its notes went verbatim here. Spec 09,
    // criterion 13: at `none` the ids go and nothing else, whichever tool is asked.
    if (withholdsText(context)) {
      return {
        ok: true,
        data: {
          projects: listProjects(context.database, args.state).map((project) => ({
            kind: 'project',
            id: project.id,
          })),
          withheld: WITHHELD_ITEM_TEXT,
        },
      }
    }

    // The stalled set is computed over the active projects whatever the filter is, so asking for
    // one state cannot change what stalled means.
    const stalled = new Set(listStalledProjects(context.database).map((project) => project.id))

    return {
      ok: true,
      data: {
        projects: listProjects(context.database, args.state).map((project) => {
          const nextAction = getProjectNextAction(context.database, project.id)
          // The body-shaped field of a project is `notes`, exactly as it is for a task, so it goes
          // through the one function every sender of a note goes through. Sending the column verbatim
          // here would have `metadata` withhold a task's note and hand over a project's. Spec 09.
          const notes = textToSend(project.notes, context.config.privacy)

          return {
            id: project.id,
            title: project.title,
            state: project.state,
            notes: notes.text,
            // Said rather than left to be inferred, as in `get_task`: a model shown three hundred
            // characters and told nothing would answer as though that were the whole note.
            ...(notes.truncated ? { notesTruncated: true } : {}),
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

    // A plan is titles, rationales and a summary written about them, so all of it is item text. What
    // survives `none` is the order the day was put in and the arithmetic behind it. Spec 09,
    // criterion 13.
    if (withholdsText(context)) {
      const ranked = (item: { rank: number; taskId: string | null }) => ({
        rank: item.rank,
        taskId: item.taskId,
      })

      return {
        ok: true,
        data: {
          date: plan.planDate,
          generatedAt: asIso(plan.generatedAt),
          capacityMinutes: plan.capacityMinutes,
          capacityVerified: plan.capacityVerified,
          planned: plan.entries.map(ranked),
          overflow: plan.overflow.map(ranked),
          chases: plan.nudges.map(ranked),
          withheld: WITHHELD_ITEM_TEXT,
        },
      }
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
    'How much free working time a day has, defaulting to today: the working window, the time the calendar has taken out of it, the reserve held back for interruptions, and what is left. Unverified means the calendar could not be read: where no events are on record the window was assumed free, and where they are the figures come from the last sync rather than a live diary.',
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
        // The numbers above are the day's arithmetic and are nobody's content. A meeting's summary is
        // a title, so at `none` the day is counted rather than named. Spec 09, criterion 13.
        ...(withholdsText(context)
          ? { withheld: WITHHELD_EVENT_TEXT }
          : {
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
            }),
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

    const shown = args.staleOnly === true ? items.filter((item) => item.stale) : items

    // A chase list is titles and the names of the people they are on, which spec 09 counts as
    // metadata: at `none` neither goes, and the ids of what is outstanding are what is left. The
    // filter is still applied, so a stale-only call still answers about the stale ones.
    if (withholdsText(context)) {
      return {
        ok: true,
        data: {
          staleAfterDays: waitingStaleDays,
          items: shown.map((item) => ({ kind: 'task', id: item.taskId })),
          withheld: WITHHELD_ITEM_TEXT,
        },
      }
    }

    return { ok: true, data: { staleAfterDays: waitingStaleDays, items: shown } }
  },
})

/**
 * The pull request facts a `review` or `waiting` task's GitHub source carries, read once and
 * shared by the two halves of `list_reviews` below.
 */
function pullRequestMetadataOf(source: Source): {
  readonly repository: string | null
  readonly number: number | null
  readonly reviewRequestedAt: string | null
} {
  const metadata = (source.metadata ?? {}) as {
    repository?: unknown
    number?: unknown
    reviewRequestedAt?: unknown
  }

  return {
    repository: typeof metadata.repository === 'string' ? metadata.repository : null,
    number: typeof metadata.number === 'number' ? metadata.number : null,
    reviewRequestedAt: asIso(
      typeof metadata.reviewRequestedAt === 'number' ? metadata.reviewRequestedAt : null,
    ),
  }
}

const listReviews = defineTool<{ readonly includeWaiting?: boolean }>({
  name: 'list_reviews',
  kind: 'read',
  description:
    'The review queue: every task awaiting your review, with its pull request URL, repository, number, size estimate, when the review was requested and where it is in the connector\'s lifecycle, in one call. Set includeWaiting to also list the ones you have reviewed and are waiting on the author for, which is "you reviewed it and nothing has happened since". Written for an agent that would otherwise need a get_task per row.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: { includeWaiting: { type: 'boolean' } },
  },
  execute(context, args) {
    const reviewTasks = listTasks(context.database, { status: ['review'] }, context.now).tasks
    const waitingTasks =
      args.includeWaiting === true
        ? listTasks(context.database, { status: ['waiting'] }, context.now).tasks
        : []

    const sources = listSourcesForTasks(context.database, [
      ...reviewTasks.map((task) => task.id),
      ...waitingTasks.map((task) => task.id),
    ])

    const withheld = withholdsText(context)

    const rows = (tasks: readonly Task[]): unknown[] =>
      tasks.flatMap((task): unknown[] => {
        const pullRequest = (sources.get(task.id) ?? []).find(
          (source) => source.provider === 'github',
        )
        // Not a pull request at all: `review` and `waiting` both hold tasks that reached that
        // status by other means, and a row with no provenance to show is not this tool's to
        // answer for. Spec 07's description says "for a pull request task" for a reason.
        if (pullRequest === undefined) return []

        const facts = pullRequestMetadataOf(pullRequest)

        if (withheld) {
          return [{ kind: 'task' as const, id: task.id, withheld: WITHHELD_ITEM_TEXT }]
        }

        return [
          {
            id: task.id,
            title: task.title,
            status: task.status,
            url: pullRequest.url,
            repository: facts.repository,
            number: facts.number,
            estimateMinutes: task.estimateMinutes,
            reviewRequestedAt: facts.reviewRequestedAt,
            lifecycleState: pullRequest.lifecycleState,
            waitingOn: task.status === 'waiting' ? task.waitingOn : null,
          },
        ]
      })

    return {
      ok: true,
      data: {
        review: rows(reviewTasks),
        ...(args.includeWaiting === true ? { waiting: rows(waitingTasks) } : {}),
        ...(withheld ? { withheld: WITHHELD_ITEM_TEXT } : {}),
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
  listReviews,
]

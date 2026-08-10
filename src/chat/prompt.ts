/**
 * What chat is told, and what it is told about the day. Versioned in the repository as the other
 * prompts are, so a change in behaviour is traceable to a change in what was asked.
 *
 * This is a send boundary for spec 09, and a narrow one: the context is counts, a plan summary and
 * a number of free minutes. No task title, let alone a message body, is assembled here. Detail
 * reaches the model only through a tool the model chose to call, which is spec 07's reason for
 * fetching rather than dumping and has the side effect of keeping this boundary trivial to check.
 */
import { capacityForDate } from '../actions/capacity.js'
import { waitingItemsFor } from '../actions/waiting.js'
import type { Config } from '../config/schema.js'
import type { Database } from '../db/connection.js'
import { latestDailyPlan } from '../db/repositories/daily-plans.js'
import { listStalledProjects } from '../db/repositories/projects.js'
import { countTasksByStatus, listTasks } from '../db/repositories/tasks.js'
import { taskStatuses } from '../domain/task.js'
import { formatLocalDate, localDateAt } from '../domain/time.js'
import { isStaleWait } from '../domain/waiting.js'

/**
 * Bumped whenever the wording or the assembled context changes in a way that could change how
 * chat behaves. Dated rather than numbered, as for the other prompts.
 */
export const CHAT_PROMPT_VERSION = '2026-08-10'

/** Counts per status, the plan if there is one, and what is left of the day. Spec 07. */
export interface ChatContext {
  readonly today: string
  readonly timeZone: string
  readonly counts: Readonly<Record<string, number>>
  readonly plan: {
    readonly summary: string | null
    readonly planned: number
    readonly done: number
    readonly capacityMinutes: number
    readonly capacityVerified: boolean
  } | null
  readonly capacity: {
    readonly workingDay: boolean
    readonly capacityMinutes: number
    readonly busyMinutes: number
    readonly verified: boolean
  }
  readonly waiting: { readonly total: number; readonly stale: number }
  readonly stalledProjects: number
}

export interface ChatContextOptions {
  readonly database: Database
  readonly config: Config
  readonly now: number
  readonly calendarConnected: () => boolean
}

export function buildChatContext({
  database,
  config,
  now,
  calendarConnected,
}: ChatContextOptions): ChatContext {
  const timeZone = config.jobs.timezone
  const date = localDateAt(now, timeZone)
  const today = formatLocalDate(date)

  const stored = countTasksByStatus(database)
  const counts: Record<string, number> = {}
  for (const status of taskStatuses) counts[status] = stored.get(status) ?? 0

  const plan = latestDailyPlan(database, today)
  const capacity = capacityForDate(database, config, date, calendarConnected())

  const waiting = waitingItemsFor(database, listTasks(database, { status: ['waiting'] }, now).tasks)

  return {
    today,
    timeZone,
    counts,
    plan:
      plan === null
        ? null
        : {
            summary: plan.summary,
            planned: plan.entries.length,
            done: plan.entries.filter((entry) => entry.done).length,
            capacityMinutes: plan.capacityMinutes,
            capacityVerified: plan.capacityVerified,
          },
    capacity: {
      workingDay: capacity.workingDay,
      capacityMinutes: capacity.capacityMinutes,
      busyMinutes: capacity.busyMinutes,
      verified: capacity.verified,
    },
    waiting: {
      total: waiting.length,
      stale: waiting.filter((item) =>
        isStaleWait(
          // The wait has already been dated by `waitingItemsFor`, which knows whether the moment
          // came from a source or from the task, so it is passed as the moment rather than dated
          // a second time from a shape that no longer has both.
          { statusSetAt: item.waitingSince },
          null,
          now,
          config.tasks.waitingStaleDays,
        ),
      ).length,
    },
    stalledProjects: listStalledProjects(database).length,
  }
}

function writeRules({ bulkThreshold, maxToolCalls }: PromptLimits): string {
  return `You can change things, and every change you make is the user's decision rather than a suggestion: it happens immediately and is recorded in the transcript with an undo control.

- Make the change the user asked for and no more. Do not tidy up on the side.
- Before changing something you are not certain about, look it up. A wrong id changes the wrong task.
- Deleting always waits for the user to confirm, however clear the instruction. Propose it and say why; you will be told it was held, and that is not a failure.
- Past ${bulkThreshold} tasks changed in one turn, the rest of your changes are held for confirmation too. Carry on and say what you have proposed.
- You have ${maxToolCalls} tool calls for this turn. Spend them on what was asked.
- Say what you did, one line per change, in plain language. Do not restate the tool call.`
}

const READ_ONLY_RULES = `You cannot change anything in this conversation: the configured model cannot use tools, so no tool is available to you, not even to look something up.

Answer from the figures above and from what the user tells you. Say plainly when you would need to look something up or make a change and cannot. Never say you have changed, created, completed or deleted anything: nothing you say can change a single task here.`

/** The two limits the model is told about, so that hitting one is not a surprise to it. */
export interface PromptLimits {
  readonly bulkThreshold: number
  readonly maxToolCalls: number
}

export interface PromptOptions extends PromptLimits {
  readonly readOnly: boolean
}

/**
 * The system prompt. The rules are stated in full both ways round, because the read-only turn is
 * the one where a model left to infer its situation invents a change it did not make, and spec 07
 * criterion 7 is exactly that it must not.
 */
export function chatSystemPrompt(context: ChatContext, options: PromptOptions): string {
  return `You are Caroline, one person's task assistant. You help them triage their inbox, reshape their projects, and understand what today looks like and why. Caroline is a GTD system: work sits in inbox, next_action, review, waiting, someday, reference or done.

Talk like a colleague who knows the system: short, specific, no preamble and no restating of the question. Where a number matters, give the number.

Today is ${context.today} (${context.timeZone}).

${JSON.stringify(contextPayload(context), null, 2)}

That is all you are given. Anything more specific, including any task's title, you fetch with a tool, so that you are reading the system as it is now rather than as it was when this turn began.

${options.readOnly ? READ_ONLY_RULES : writeRules(options)}`
}

/** The context as it is sent: named fields, so nothing arrives here by inheritance. Spec 09. */
export function contextPayload(context: ChatContext) {
  return {
    taskCountsByStatus: context.counts,
    todaysPlan: context.plan,
    todaysCapacity: context.capacity,
    waiting: context.waiting,
    stalledProjects: context.stalledProjects,
  }
}

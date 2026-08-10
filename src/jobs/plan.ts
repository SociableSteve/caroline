/**
 * The planner: propose a realistic list of what to do today, sized to the free time the
 * calendar actually leaves, and ordered with a stated reason. Spec 05.
 *
 * The model ranks; this file decides. Every rule in spec 05's "enforced in code after the
 * model returns" paragraph is applied here, through `src/domain/plan.ts`, after the answer
 * comes back and before any of it is written.
 *
 * Nothing here writes to `tasks`. Criterion 9: generating a plan changes no task row.
 */
import type { Config } from '../config/schema.js'
import type { Database } from '../db/connection.js'
import { listCalendarEvents } from '../db/repositories/calendar-events.js'
import {
  recordDailyPlan,
  type DailyPlan,
  type DailyPlanEntryInput,
  type DailyPlanNudgeInput,
} from '../db/repositories/daily-plans.js'
import { listProjects } from '../db/repositories/projects.js'
import { listSourcesForTasks } from '../db/repositories/sources.js'
import { listTasks } from '../db/repositories/tasks.js'
import { computeCapacity, workingWindowFor, type Capacity } from '../domain/capacity.js'
import { noCounts, type JobCounts, type JobRunStatus } from '../domain/job.js'
import {
  applyPlanRules,
  chaseNudges,
  planCandidates,
  type ChaseNudge,
  type PlanCandidate,
  type PlannedEntry,
  type RankedEntry,
  type WaitingItem,
} from '../domain/plan.js'
import { hasNewCommitsSinceActing } from '../domain/review.js'
import type { Source } from '../domain/source.js'
import type { Task } from '../domain/task.js'
import { formatLocalDate, instantAt, localDateAt, type LocalDate } from '../domain/time.js'
import { waitingSince } from '../domain/waiting.js'
import type { LlmRuntime } from '../llm/index.js'
import {
  buildPlanPayload,
  planRequestText,
  planSchema,
  PLAN_PROMPT_VERSION,
  PLAN_SYSTEM_PROMPT,
} from '../llm/prompts/plan.js'

export const PLAN_JOB = 'plan'

export interface PlanJobOptions {
  readonly database: Database
  readonly config: Config
  readonly llm: LlmRuntime
  /** Whether a calendar is actually connected. False makes the capacity unverified. */
  readonly calendarConnected: () => boolean
  readonly now: () => number
  /** The day to plan. Defaults to today in the configured zone. */
  readonly date?: LocalDate
}

export interface PlanResult {
  readonly status: JobRunStatus
  readonly counts: JobCounts
  readonly error: string | null
  /** The plan that was written, or null when none was. */
  readonly plan: DailyPlan | null
}

/** How many minutes into the day a local `HH:MM` is. The config carries the readable form. */
function minutesOfDay(time: string): number {
  const [hour = '0', minute = '0'] = time.split(':')
  return Number(hour) * 60 + Number(minute)
}

function skipped(error: string): PlanResult {
  return { status: 'skipped', counts: noCounts, error, plan: null }
}

/**
 * One planning run. Returns what happened rather than recording it: the scheduler owns the
 * `job_runs` row, so a manual run and a scheduled one are recorded the same way.
 */
export async function runPlanning(options: PlanJobOptions): Promise<PlanResult> {
  const { config, llm, now } = options

  // At `none` there is nothing the model could be told about a task, not even its title, so
  // planning is disabled rather than attempted with a list of identifiers. Spec 09.
  if (config.privacy.llmContent === 'none') {
    return skipped('privacy.llmContent is "none", so there is nothing to plan with.')
  }

  if (!llm.isConfigured('planning')) {
    return skipped('No LLM provider is configured, so the day cannot be planned.')
  }

  const timeZone = config.jobs.timezone
  const date = options.date ?? localDateAt(now(), timeZone)
  const day = dayContext(options, date, timeZone)

  try {
    return await draw(options, date, timeZone, day)
  } catch (error) {
    // A failed call leaves no plan at all rather than an empty one. An empty plan is a claim
    // that there is nothing to do today, and that is not what happened.
    const message = error instanceof Error ? error.message : String(error)
    return { status: 'failure', counts: { ...noCounts, llmCalls: 1 }, error: message, plan: null }
  }
}

/** Everything about the day that does not depend on the model. */
interface DayContext {
  readonly capacity: Capacity | null
  readonly capacityVerified: boolean
  readonly candidates: readonly PlanCandidate[]
  readonly nudges: readonly ChaseNudge[]
  readonly projectTitles: ReadonlyMap<string, string>
  readonly dueBy: number
  readonly warnings: readonly string[]
}

function dayContext(
  { database, config, calendarConnected, now }: PlanJobOptions,
  date: LocalDate,
  timeZone: string,
): DayContext {
  const warnings: string[] = []
  const { workingWindow, workingDays, reservePercent, countAllDayEvents } = config.planning

  const window = workingWindowFor(date, timeZone, {
    startMinute: minutesOfDay(workingWindow.start),
    endMinute: minutesOfDay(workingWindow.end),
    days: workingDays,
  })

  // Midnight at the end of the day, which is what "due today" is measured against. Taken from
  // the day itself rather than from the window, so a deadline at eight in the evening is still
  // due today on a day that stops working at half past five.
  const dueBy = (instantAt(date, 23 * 60 + 59, timeZone) ?? now()) + 59_999

  const verified = calendarConnected()
  if (!verified) {
    warnings.push(
      'No calendar is connected, so this capacity is unverified: it assumes the whole working window is free.',
    )
  }

  const capacity =
    window === null
      ? null
      : computeCapacity({
          window,
          // Whatever is stored. With nothing ever connected there is nothing to read, and the
          // window is taken as free; disconnecting clears the diary, so there is no third case.
          events: listCalendarEvents(database, { from: window.start, to: window.end }),
          reservePercent,
          countAllDayEvents,
        })

  if (window === null) {
    warnings.push(
      `${formatLocalDate(date)} is not a working day, so there is no capacity to plan into.`,
    )
  }

  const tasks = listTasks(database, {}, now()).tasks
  const sources = listSourcesForTasks(
    database,
    tasks.map((task) => task.id),
  )

  return {
    capacity,
    capacityVerified: verified,
    // A day with no window has no work in it, so nothing is offered to the model either.
    candidates: window === null ? [] : planCandidates(tasks, dueBy),
    nudges: chaseNudges(waitingItems(tasks, sources), now(), config.tasks.waitingStaleDays),
    projectTitles: new Map(listProjects(database).map((project) => [project.id, project.title])),
    dueBy,
    warnings,
  }
}

/** The waiting items, each dated from the moment it became somebody else's turn. Spec 02. */
function waitingItems(
  tasks: readonly Task[],
  sources: ReadonlyMap<string, Source[]>,
): WaitingItem[] {
  return tasks
    .filter((task) => task.status === 'waiting')
    .map((task) => {
      const pullRequest = (sources.get(task.id) ?? []).find(
        (source) => source.provider === 'github',
      )
      const metadata = (pullRequest?.metadata ?? {}) as {
        headSha?: unknown
        headCommittedAt?: unknown
      }

      return {
        taskId: task.id,
        title: task.title,
        waitingOn: task.waitingOn,
        waitingSince: waitingSince(task, pullRequest ?? null),
        isPullRequest: pullRequest !== undefined,
        // The state machine's own judgement, imported rather than reimplemented, so the nudge
        // and the card cannot come to different conclusions about the same two shas.
        pushedSinceReview:
          pullRequest !== undefined && typeof metadata.headSha === 'string'
            ? hasNewCommitsSinceActing(
                {
                  headSha: metadata.headSha,
                  headCommittedAt:
                    typeof metadata.headCommittedAt === 'number' ? metadata.headCommittedAt : null,
                },
                pullRequest,
              )
            : false,
      }
    })
}

/** Asks the model, applies the rules, and writes the result. */
async function draw(
  { database, config, llm, now }: PlanJobOptions,
  date: LocalDate,
  timeZone: string,
  day: DayContext,
): Promise<PlanResult> {
  const planDate = formatLocalDate(date)
  const capacityMinutes = day.capacity?.capacityMinutes ?? 0
  const provider = day.candidates.length === 0 ? null : llm.for('planning')

  // Nothing to rank is not a reason to spend a call. A day with no eligible work has one
  // honest plan, and asking a model to produce it would cost money to be told so.
  const answer =
    provider === null
      ? { summary: 'Nothing is eligible for planning today.', entries: [] as RankedEntry[] }
      : await ask(provider, config, day, planDate)

  const rules = applyPlanRules({
    ranked: answer.entries,
    candidates: day.candidates,
    capacityMinutes,
    defaultEstimateMinutes: config.planning.defaultEstimateMinutes,
    dueBy: day.dueBy,
  })

  const plan = recordDailyPlan(database, {
    planDate,
    generatedAt: now(),
    timeZone,
    windowMinutes: day.capacity?.windowMinutes ?? 0,
    busyMinutes: day.capacity?.busyMinutes ?? 0,
    reserveMinutes: day.capacity?.reserveMinutes ?? 0,
    capacityMinutes,
    capacityVerified: day.capacityVerified,
    provider: provider?.name ?? null,
    model: provider?.model ?? null,
    promptVersion: PLAN_PROMPT_VERSION,
    summary: answer.summary,
    warnings: [...day.warnings, ...rules.warnings],
    entries: rules.entries.map(toEntryInput),
    overflow: rules.overflow.map(toEntryInput),
    nudges: day.nudges.map(toNudgeInput),
  })

  return {
    status: 'success',
    counts: { ...noCounts, plansGenerated: 1, llmCalls: provider === null ? 0 : 1 },
    error: null,
    plan,
  }
}

interface PlanAnswer {
  readonly summary: string
  readonly entries: readonly RankedEntry[]
}

async function ask(
  provider: ReturnType<LlmRuntime['for']>,
  config: Config,
  day: DayContext,
  planDate: string,
): Promise<PlanAnswer> {
  const payload = buildPlanPayload({
    date: planDate,
    capacityMinutes: day.capacity?.capacityMinutes ?? 0,
    workingWindowMinutes: day.capacity?.windowMinutes ?? 0,
    busyMinutes: day.capacity?.busyMinutes ?? 0,
    capacityVerified: day.capacityVerified,
    chases: day.nudges.length,
    candidates: day.candidates,
    projectTitles: day.projectTitles,
    dueBy: day.dueBy,
  })

  const result = await provider.complete({
    system: PLAN_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: planRequestText(payload) }],
    schema: planSchema,
    maxTokens: config.llm.maxTokens,
  })

  const structured = result.structured as {
    summary: string
    entries: ReadonlyArray<{ taskId: string; rationale: string; estimateMinutes?: number | null }>
  }

  return {
    summary: structured.summary,
    entries: structured.entries.map((entry) => ({
      taskId: entry.taskId,
      rationale: entry.rationale,
      estimateMinutes: entry.estimateMinutes ?? null,
    })),
  }
}

function toEntryInput(entry: PlannedEntry): DailyPlanEntryInput {
  return {
    taskId: entry.taskId,
    title: entry.title,
    rank: entry.rank,
    rationale: entry.rationale,
    estimateMinutes: entry.estimateMinutes,
  }
}

function toNudgeInput(nudge: ChaseNudge, index: number): DailyPlanNudgeInput {
  return {
    taskId: nudge.taskId,
    title: nudge.title,
    rank: index + 1,
    waitingOn: nudge.waitingOn,
    waitingSince: nudge.waitingSince,
    pushedSinceReview: nudge.pushedSinceReview,
  }
}

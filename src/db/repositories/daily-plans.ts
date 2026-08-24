/**
 * The plan store. Spec 05: a plan is a proposal, regenerating keeps the previous one, and the
 * dashboard shows planned against completed for the last fortnight.
 *
 * Nothing here writes to `tasks`. Criterion 9 is that generating a plan changes no task row,
 * and a repository with no task write in it is the plainest way to keep that true.
 */
import { randomUUID } from 'node:crypto'
import { withTransaction, type Database } from '../connection.js'
import { booleanToInteger, type Row } from '../rows.js'
import type { PlanEntryKind } from '../../domain/plan.js'
import type { TaskStatus } from '../../domain/task.js'

/** A planned or overflow entry, as it is written. */
export interface DailyPlanEntryInput {
  readonly taskId: string | null
  readonly title: string
  readonly rank: number
  readonly rationale: string | null
  readonly estimateMinutes: number | null
}

/** A chase nudge, as it is written. Nudges carry no estimate: they consume no capacity. */
export interface DailyPlanNudgeInput {
  readonly taskId: string | null
  readonly title: string
  readonly rank: number
  readonly waitingOn: string | null
  readonly waitingSince: number | null
  readonly pushedSinceReview: boolean
}

export interface RecordDailyPlanInput {
  /** The local calendar date, `YYYY-MM-DD`. */
  readonly planDate: string
  readonly generatedAt: number
  readonly timeZone: string
  readonly windowMinutes: number
  readonly busyMinutes: number
  readonly reserveMinutes: number
  readonly capacityMinutes: number
  /**
   * False when no calendar could be read: the window was taken as free where nothing was ever
   * synced, and drawn from the last sync where events were on record. Criterion 10.
   */
  readonly capacityVerified: boolean
  readonly provider: string | null
  readonly model: string | null
  readonly promptVersion: string
  readonly summary: string | null
  readonly warnings: readonly string[]
  readonly entries: readonly DailyPlanEntryInput[]
  readonly overflow: readonly DailyPlanEntryInput[]
  readonly nudges: readonly DailyPlanNudgeInput[]
}

/** An entry as it is read back, with the task's status as it stands now rather than then. */
export interface DailyPlanEntry {
  readonly id: string
  readonly kind: PlanEntryKind
  readonly rank: number
  /** Null once the task has been deleted. The entry survives, because the plan is a record. */
  readonly taskId: string | null
  readonly title: string
  readonly rationale: string | null
  readonly estimateMinutes: number | null
  readonly waitingOn: string | null
  readonly waitingSince: number | null
  readonly pushedSinceReview: boolean
  /** Read at the moment of asking, so the plan view renders a completed entry as done. */
  readonly taskStatus: TaskStatus | null
  /**
   * Who or what the task is waiting on, read at the same moment as `taskStatus`: the blocker's
   * title while it is blocked, the person while it is waiting, and null otherwise. `waitingOn`
   * above is what the planner recorded, and the two say different things once the task moves, so a
   * surface that presents an entry under its live status has to name what it is under live too.
   * Spec 05, criterion 20.
   */
  readonly currentWaitingOn: string | null
  readonly done: boolean
}

export interface DailyPlan {
  readonly id: string
  readonly planDate: string
  readonly generatedAt: number
  readonly timeZone: string
  readonly windowMinutes: number
  readonly busyMinutes: number
  readonly reserveMinutes: number
  readonly capacityMinutes: number
  readonly capacityVerified: boolean
  readonly provider: string | null
  readonly model: string | null
  readonly promptVersion: string
  readonly summary: string | null
  readonly warnings: readonly string[]
  readonly entries: readonly DailyPlanEntry[]
  readonly overflow: readonly DailyPlanEntry[]
  readonly nudges: readonly DailyPlanEntry[]
}

const planColumns = `id, plan_date, generated_at, time_zone, window_minutes, busy_minutes,
  reserve_minutes, capacity_minutes, capacity_verified, provider, model, prompt_version,
  summary, warnings`

const entryColumnNames = [
  'id',
  'plan_id',
  'kind',
  'rank',
  'task_id',
  'title',
  'rationale',
  'estimate_minutes',
  'waiting_on',
  'waiting_since',
  'pushed_since_review',
] as const

const entryColumns = entryColumnNames.join(', ')

/** The same list, qualified, for the read that joins `tasks` and would be ambiguous without. */
const qualifiedEntryColumns = entryColumnNames
  .map((column) => `daily_plan_entries.${column}`)
  .join(', ')

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value)
}

function toEntry(row: Row): DailyPlanEntry {
  const taskStatus = nullableText(row.task_status) as TaskStatus | null

  return {
    id: String(row.id),
    kind: String(row.kind) as PlanEntryKind,
    rank: Number(row.rank),
    taskId: nullableText(row.task_id),
    title: String(row.title),
    rationale: nullableText(row.rationale),
    estimateMinutes: nullableNumber(row.estimate_minutes),
    waitingOn: nullableText(row.waiting_on),
    waitingSince: nullableNumber(row.waiting_since),
    pushedSinceReview: Number(row.pushed_since_review) !== 0,
    taskStatus,
    currentWaitingOn: nullableText(row.current_waiting_on),
    done: taskStatus === 'done',
  }
}

function entriesOf(database: Database, planId: string): DailyPlanEntry[] {
  return database
    .prepare(
      `select ${qualifiedEntryColumns}, tasks.status as task_status,
         case
           when tasks.status = 'blocked' then blocker.title
           else tasks.waiting_on
         end as current_waiting_on
       from daily_plan_entries
       left join tasks on tasks.id = daily_plan_entries.task_id
       left join tasks as blocker on blocker.id = tasks.blocked_by
       where plan_id = ?
       order by daily_plan_entries.rank, daily_plan_entries.id`,
    )
    .all(planId)
    .map((row) => toEntry(row as Row))
}

function toPlan(database: Database, row: Row): DailyPlan {
  const id = String(row.id)
  const entries = entriesOf(database, id)
  const warnings = row.warnings

  return {
    id,
    planDate: String(row.plan_date),
    generatedAt: Number(row.generated_at),
    timeZone: String(row.time_zone),
    windowMinutes: Number(row.window_minutes),
    busyMinutes: Number(row.busy_minutes),
    reserveMinutes: Number(row.reserve_minutes),
    capacityMinutes: Number(row.capacity_minutes),
    capacityVerified: Number(row.capacity_verified) !== 0,
    provider: nullableText(row.provider),
    model: nullableText(row.model),
    promptVersion: String(row.prompt_version),
    summary: nullableText(row.summary),
    warnings: typeof warnings === 'string' ? (JSON.parse(warnings) as string[]) : [],
    entries: entries.filter((entry) => entry.kind === 'plan'),
    overflow: entries.filter((entry) => entry.kind === 'overflow'),
    nudges: entries.filter((entry) => entry.kind === 'nudge'),
  }
}

/**
 * Writes one generation of a plan. A new row every time, never an update: criterion 8 asks
 * that regenerating preserve the previous plan, and the whole plan lands in one transaction so
 * a failure part-way through leaves no plan with half its entries.
 */
export function recordDailyPlan(database: Database, input: RecordDailyPlanInput): DailyPlan {
  const id = randomUUID()

  return withTransaction(database, () => {
    database
      .prepare(
        `insert into daily_plans (${planColumns}) values (
           :id, :plan_date, :generated_at, :time_zone, :window_minutes, :busy_minutes,
           :reserve_minutes, :capacity_minutes, :capacity_verified, :provider, :model,
           :prompt_version, :summary, :warnings
         )`,
      )
      .run({
        id,
        plan_date: input.planDate,
        generated_at: input.generatedAt,
        time_zone: input.timeZone,
        window_minutes: input.windowMinutes,
        busy_minutes: input.busyMinutes,
        reserve_minutes: input.reserveMinutes,
        capacity_minutes: input.capacityMinutes,
        capacity_verified: booleanToInteger(input.capacityVerified),
        provider: input.provider,
        model: input.model,
        prompt_version: input.promptVersion,
        summary: input.summary,
        warnings: JSON.stringify([...input.warnings]),
      })

    const insert = database.prepare(
      `insert into daily_plan_entries (${entryColumns}) values (
         :id, :plan_id, :kind, :rank, :task_id, :title, :rationale, :estimate_minutes,
         :waiting_on, :waiting_since, :pushed_since_review
       )`,
    )

    /** The columns every kind of entry shares, so the two writers below say only their own. */
    const common = (
      kind: PlanEntryKind,
      entry: { taskId: string | null; title: string; rank: number },
    ) => ({
      id: randomUUID(),
      plan_id: id,
      kind,
      rank: entry.rank,
      task_id: entry.taskId,
      title: entry.title,
    })

    const writeWorkItem = (kind: 'plan' | 'overflow', entry: DailyPlanEntryInput): void => {
      insert.run({
        ...common(kind, entry),
        rationale: entry.rationale,
        estimate_minutes: entry.estimateMinutes,
        // A work item is not waiting on anybody, and the columns that say so stay empty.
        waiting_on: null,
        waiting_since: null,
        pushed_since_review: 0,
      })
    }

    const writeNudge = (nudge: DailyPlanNudgeInput): void => {
      insert.run({
        ...common('nudge', nudge),
        // A nudge is a prompt to decide, not a scheduled block of work, so it carries no
        // estimate: there is nothing for one to be subtracted from. Spec 05.
        rationale: null,
        estimate_minutes: null,
        waiting_on: nudge.waitingOn,
        waiting_since: nudge.waitingSince,
        pushed_since_review: booleanToInteger(nudge.pushedSinceReview),
      })
    }

    for (const entry of input.entries) writeWorkItem('plan', entry)
    for (const entry of input.overflow) writeWorkItem('overflow', entry)
    for (const nudge of input.nudges) writeNudge(nudge)

    const row = database.prepare(`select ${planColumns} from daily_plans where id = ?`).get(id)
    return toPlan(database, row as Row)
  })
}

/**
 * The plan entries naming a task. Read before a delete, so that undoing one can put the links back:
 * `task_id` is `on delete set null` (migration 5), which keeps the record of what was proposed and
 * loses the entry's connection to the task. Without this an undone delete would leave today's plan
 * unable to mark that entry done.
 */
export function listPlanEntryIdsForTask(database: Database, taskId: string): string[] {
  return database
    .prepare('select id from daily_plan_entries where task_id = ? order by id')
    .all(taskId)
    .map((row) => String((row as Row).id))
}

/** Reattaches a plan entry to a task. The other half of the read above. */
export function relinkPlanEntry(database: Database, entryId: string, taskId: string): void {
  database.prepare('update daily_plan_entries set task_id = ? where id = ?').run(taskId, entryId)
}

export interface DailyPlanQuery {
  readonly planDate?: string
  readonly limit?: number
}

/** Newest first. Regenerating a day puts the new plan at the top and leaves the old below it. */
export function listDailyPlans(database: Database, query: DailyPlanQuery = {}): DailyPlan[] {
  const where = query.planDate === undefined ? '' : 'where plan_date = ?'
  const params = query.planDate === undefined ? [] : [query.planDate]

  return database
    .prepare(
      `select ${planColumns} from daily_plans ${where}
       order by plan_date desc, generated_at desc, id limit ?`,
    )
    .all(...params, query.limit ?? 50)
    .map((row) => toPlan(database, row as Row))
}

/** The plan in force for a date: the most recent generation of it. Null when there is none. */
export function latestDailyPlan(database: Database, planDate: string): DailyPlan | null {
  return listDailyPlans(database, { planDate, limit: 1 })[0] ?? null
}

export interface PlanHistoryRange {
  readonly from: string
  readonly to: string
}

export interface PlanHistoryDay {
  readonly planDate: string
  /** Work items planned that day. Overflow and nudges are neither planned nor work. */
  readonly planned: number
  /** How many of them are done now. Spec 05 records the gap and draws no conclusion from it. */
  readonly completed: number
}

/**
 * Planned against completed, per day, for the dashboard's fortnight. Only the latest plan for
 * each date is counted: an earlier generation was superseded, and counting both would report a
 * day that was replanned as a day with twice the work in it.
 *
 * Days with no plan are absent rather than reported as zero. Nothing was planned because
 * nothing ran, which is a different fact from a day that was planned and came to nothing.
 */
export function planHistory(database: Database, { from, to }: PlanHistoryRange): PlanHistoryDay[] {
  return database
    .prepare(
      `with latest as (
         select plan_date, id,
           row_number() over (
             partition by plan_date order by generated_at desc, id desc
           ) as generation
         from daily_plans
         where plan_date >= ? and plan_date <= ?
       )
       select latest.plan_date,
         count(entry.id) as planned,
         sum(case when tasks.status = 'done' then 1 else 0 end) as completed
       from latest
       left join daily_plan_entries entry
         on entry.plan_id = latest.id and entry.kind = 'plan'
       left join tasks on tasks.id = entry.task_id
       where latest.generation = 1
       group by latest.plan_date
       order by latest.plan_date`,
    )
    .all(from, to)
    .map((row) => ({
      planDate: String((row as Row).plan_date),
      planned: Number((row as Row).planned),
      completed: Number((row as Row).completed ?? 0),
    }))
}

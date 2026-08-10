/**
 * The daily plan's rules, as pure functions: which tasks are eligible, and what has to be
 * true of the model's answer before it becomes a plan. Spec 05.
 *
 * The point of this file is the paragraph in spec 05 that begins "Rules the plan must obey,
 * enforced in code after the model returns rather than trusted to the prompt". A prompt is a
 * request; these are guarantees, so they live where they can be asserted without a model.
 */
import type { Task, TaskStatus } from './task.js'

const DAY_MS = 24 * 60 * 60_000

/**
 * The three sections a plan has: what is planned, what is there if the day opens up, and who
 * needs chasing. Spec 05. Here rather than in the repository because it is the shape of a
 * plan rather than of a table, and the migration is checked against it.
 */
export const planEntryKinds = ['plan', 'overflow', 'nudge'] as const
export type PlanEntryKind = (typeof planEntryKinds)[number]

/** A task the planner may choose from, reduced to the facts the rules turn on. */
export interface PlanCandidate {
  readonly taskId: string
  readonly title: string
  readonly status: TaskStatus
  readonly estimateMinutes: number | null
  readonly dueAt: number | null
  /** So the model can be shown a project's name rather than a uuid. */
  readonly projectId: string | null
}

/**
 * Statuses that are never work for today, whatever else is true of the task. Spec 05 excludes
 * `someday` and `reference` outright, and takes `waiting` out of the work list because the
 * next move belongs to someone else: a waiting item past the threshold returns as a nudge.
 */
const neverPlanned: readonly TaskStatus[] = ['someday', 'reference', 'waiting', 'done']

/**
 * The tasks eligible for a plan for the day ending at `dueBy`. Spec 05's Candidates section:
 * next actions not deferred past today, every review, and anything else due today or overdue.
 * A deferral to later the same day is not a deferral past today, so the task is a candidate.
 */
export function planCandidates(tasks: readonly Task[], dueBy: number): PlanCandidate[] {
  return tasks.filter((task) => isCandidate(task, dueBy)).map(toCandidate)
}

function isCandidate(task: Task, dueBy: number): boolean {
  if (neverPlanned.includes(task.status)) return false
  if (task.status === 'review') return true

  if (task.status === 'next_action') {
    return task.deferUntil === null || task.deferUntil <= dueBy
  }

  // Everything else, `inbox` in practice, only on the strength of a deadline that has arrived.
  return task.dueAt !== null && task.dueAt <= dueBy
}

function toCandidate(task: Task): PlanCandidate {
  return {
    taskId: task.id,
    title: task.title,
    status: task.status,
    estimateMinutes: task.estimateMinutes,
    dueAt: task.dueAt,
    projectId: task.projectId,
  }
}

/** One entry as the model ranked it, before any of the rules have been applied. */
export interface RankedEntry {
  readonly taskId: string
  readonly rationale: string
  readonly estimateMinutes: number | null
}

/** One entry as it reaches the plan: fitted, ranked and with the estimate actually used. */
export interface PlannedEntry {
  readonly taskId: string
  readonly title: string
  readonly rank: number
  readonly rationale: string
  readonly estimateMinutes: number
  /** Due today or overdue. What puts it in front of discretionary work. */
  readonly urgent: boolean
}

export interface PlanRulesInput {
  readonly ranked: readonly RankedEntry[]
  readonly candidates: readonly PlanCandidate[]
  readonly capacityMinutes: number
  /** For a task with no estimate anywhere. Spec 05 defaults it to thirty minutes. */
  readonly defaultEstimateMinutes: number
  /** The end of the day being planned, which is what "due today" means. */
  readonly dueBy: number
}

export interface PlanRulesResult {
  readonly entries: readonly PlannedEntry[]
  /** The "if there is time" list. Spec 05: excess is moved here, never dropped. */
  readonly overflow: readonly PlannedEntry[]
  readonly warnings: readonly string[]
}

/** An entry before it has been placed, carrying what the rules need to place it. */
interface Considered {
  readonly candidate: PlanCandidate
  readonly rationale: string
  readonly estimateMinutes: number
  readonly urgent: boolean
}

function rank(entries: readonly Considered[], from = 1): PlannedEntry[] {
  return entries.map((entry, index) => ({
    taskId: entry.candidate.taskId,
    title: entry.candidate.title,
    rank: from + index,
    rationale: entry.rationale,
    estimateMinutes: entry.estimateMinutes,
    urgent: entry.urgent,
  }))
}

/**
 * The model's answer, made to obey spec 05's rules. In order:
 *
 * 1. Entries naming something that was never a candidate are dropped, and named in a warning.
 *    A plan is acted on, and an item nobody put in front of the model is one it invented.
 * 2. Every entry gets a usable estimate, so everything can be fitted.
 * 3. Urgent work moves in front of discretionary work, keeping the model's own order within
 *    each group: the ordering rule is the constraint, and the ranking within it is the
 *    judgement the model was asked for.
 * 4. A review is planned whenever the queue is not empty and there is room for one.
 * 5. Entries are fitted until the capacity runs out; the rest become overflow.
 */
export function applyPlanRules({
  ranked,
  candidates,
  capacityMinutes,
  defaultEstimateMinutes,
  dueBy,
}: PlanRulesInput): PlanRulesResult {
  const byId = new Map(candidates.map((candidate) => [candidate.taskId, candidate]))
  const warnings: string[] = []
  const considered: Considered[] = []
  const seen = new Set<string>()

  for (const entry of ranked) {
    const candidate = byId.get(entry.taskId)
    if (candidate === undefined) {
      warnings.push(
        `The model planned "${entry.taskId}", which is not one of today's tasks, so it was left out.`,
      )
      continue
    }
    // First mention wins. A task planned twice is one task, and the second entry would spend
    // the same capacity again on work that is already in the list.
    if (seen.has(entry.taskId)) continue
    seen.add(entry.taskId)

    considered.push(consider(candidate, entry, defaultEstimateMinutes, dueBy))
  }

  const ordered = [
    ...considered.filter((entry) => entry.urgent),
    ...considered.filter((entry) => !entry.urgent),
  ]

  const withReview = ensureReview(
    ordered,
    candidates,
    capacityMinutes,
    defaultEstimateMinutes,
    dueBy,
  )

  if (capacityMinutes <= 0) {
    warnings.push(
      'There is no free capacity today, so nothing is planned. Everything below is there if the day opens up.',
    )
    return { entries: [], overflow: rank(withReview), warnings }
  }

  const { fitted, overflow } = fit(withReview, capacityMinutes)

  return { entries: rank(fitted), overflow: rank(overflow), warnings }
}

function consider(
  candidate: PlanCandidate,
  entry: RankedEntry,
  defaultEstimateMinutes: number,
  dueBy: number,
): Considered {
  return {
    candidate,
    rationale: entry.rationale,
    estimateMinutes: estimateFor(entry.estimateMinutes, candidate, defaultEstimateMinutes),
    urgent: candidate.dueAt !== null && candidate.dueAt <= dueBy,
  }
}

/** The model's guess, then the task's own, then the configured default. Spec 05. */
function estimateFor(
  proposed: number | null,
  candidate: PlanCandidate,
  defaultEstimateMinutes: number,
): number {
  const minutes = proposed ?? candidate.estimateMinutes ?? defaultEstimateMinutes
  // An estimate of zero would let an unbounded number of entries into the day for free.
  return Math.max(1, Math.round(minutes))
}

/**
 * Criterion 7: at least one review appears whenever the review queue is not empty and capacity
 * allows. The review is moved to the head of the discretionary group rather than the head of
 * the plan, so the urgent work stays in front of it; one the model left out entirely is added
 * there with a rationale saying why it is present.
 */
function ensureReview(
  ordered: readonly Considered[],
  candidates: readonly PlanCandidate[],
  capacityMinutes: number,
  defaultEstimateMinutes: number,
  dueBy: number,
): Considered[] {
  const reviewQueue = candidates.filter((candidate) => candidate.status === 'review')
  if (reviewQueue.length === 0) return [...ordered]

  // Already planned means already in the part of the list that will fit. Anything past the
  // capacity line is not in the plan, which is the case criterion 7 is about.
  const { fitted } = fit(ordered, capacityMinutes)
  if (fitted.some((entry) => entry.candidate.status === 'review')) return [...ordered]

  const existing = ordered.find((entry) => entry.candidate.status === 'review')
  const promoted =
    existing ??
    consider(
      reviewQueue[0] as PlanCandidate,
      {
        taskId: (reviewQueue[0] as PlanCandidate).taskId,
        rationale: 'Somebody is waiting on your review, and nothing else in the day was.',
        estimateMinutes: null,
      },
      defaultEstimateMinutes,
      dueBy,
    )

  // Capacity has to allow it. One review larger than the whole day is not something to make
  // room for by pushing out everything that would have fitted.
  if (promoted.estimateMinutes > capacityMinutes) return [...ordered]

  const rest = ordered.filter((entry) => entry !== promoted)

  return [
    ...rest.filter((entry) => entry.urgent),
    promoted,
    ...rest.filter((entry) => !entry.urgent),
  ]
}

/**
 * Criterion 5: the planned entries never total more than capacity. An entry too large for
 * what is left is stepped over rather than ending the fit, so a single outsized task does not
 * take the rest of the day's list with it into overflow.
 */
function fit(
  entries: readonly Considered[],
  capacityMinutes: number,
): { fitted: Considered[]; overflow: Considered[] } {
  const fitted: Considered[] = []
  const overflow: Considered[] = []
  let spent = 0

  for (const entry of entries) {
    if (spent + entry.estimateMinutes <= capacityMinutes) {
      fitted.push(entry)
      spent += entry.estimateMinutes
    } else {
      overflow.push(entry)
    }
  }

  return { fitted, overflow }
}

/** A waiting item as the nudge rules see it. The provenance is the caller's to resolve. */
export interface WaitingItem {
  readonly taskId: string
  readonly title: string
  readonly waitingOn: string | null
  /** When it became somebody else's turn. Spec 02: `acted_at` for a pull request. */
  readonly waitingSince: number
  readonly isPullRequest: boolean
  /** For a reviewed pull request, whether the author has pushed since. Criterion 12. */
  readonly pushedSinceReview: boolean
}

export interface ChaseNudge extends WaitingItem {
  readonly waitingMs: number
  readonly waitingDays: number
}

/**
 * The chase list for the day: waiting items past the staleness threshold, oldest first.
 *
 * They are returned separately from the plan entries and never enter the fitting, because a
 * nudge is a prompt to decide rather than a scheduled block of work. Spec 05.
 */
export function chaseNudges(
  items: readonly WaitingItem[],
  now: number,
  staleDays: number,
): ChaseNudge[] {
  return items
    .map((item) => {
      const waitingMs = Math.max(0, now - item.waitingSince)
      return { ...item, waitingMs, waitingDays: Math.floor(waitingMs / DAY_MS) }
    })
    .filter((nudge) => nudge.waitingMs >= staleDays * DAY_MS)
    .toSorted((first, second) => first.waitingSince - second.waitingSince)
}

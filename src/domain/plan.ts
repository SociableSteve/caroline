/**
 * The daily plan's rules, as pure functions: which tasks are eligible, and what has to be
 * true of the model's answer before it becomes a plan. Spec 05.
 *
 * The point of this file is the paragraph in spec 05 that begins "Rules the plan must obey,
 * enforced in code after the model returns rather than trusted to the prompt". A prompt is a
 * request; these are guarantees, so they live where they can be asserted without a model.
 */
import type { Interval } from './capacity.js'
import type { Task, TaskStatus } from './task.js'
import { isStaleWait, waitingAge } from './waiting.js'

const DAY_MS = 24 * 60 * 60_000
const MINUTE_MS = 60_000

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
 * `blocked` is here for the plainest reason of the lot, that another task has to finish first,
 * and it returns the same way: past its deadline it is a nudge rather than work. Criterion 20.
 *
 * Naming a status here is not optional bookkeeping. `isCandidate` below ends with a catch-all
 * limb reached by any status with no limb of its own, so a status added to the domain and not
 * added here is planned as work on the strength of a deadline alone, silently.
 */
const neverPlanned: readonly TaskStatus[] = ['someday', 'reference', 'waiting', 'blocked', 'done']

/**
 * Whether reviews are among the day's candidates at all. Spec 05, criterion 18: the decision is
 * `planning.includeReviews` in `caroline.config.json`, for somebody whose code review is handled
 * elsewhere. It is asked for rather than defaulted, so every caller says which it means.
 */
export interface PlanCandidateOptions {
  readonly includeReviews: boolean
}

/**
 * The tasks eligible for a plan for the day ending at `dueBy`. Spec 05's Candidates section:
 * next actions not deferred past today, every review where reviews are included, and anything else
 * due today or overdue. A deferral to later the same day is not a deferral past today, so the task
 * is a candidate.
 */
export function planCandidates(
  tasks: readonly Task[],
  dueBy: number,
  { includeReviews }: PlanCandidateOptions,
): PlanCandidate[] {
  return tasks.filter((task) => isCandidate(task, dueBy, includeReviews)).map(toCandidate)
}

function isCandidate(task: Task, dueBy: number, includeReviews: boolean): boolean {
  if (neverPlanned.includes(task.status)) return false

  // A review is answered on its status alone, either way, before any deadline is looked at. Included,
  // that is what makes the review queue the day job whatever its dates say. Excluded, it is what
  // makes the exclusion complete: a review due today would otherwise come back through the deadline
  // branch below, and criterion 18 is that none of them reaches the plan.
  if (task.status === 'review') return includeReviews

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
 * 4. A review is planned whenever the queue is not empty and there is room for one. The queue is
 *    the candidates' own reviews, so a day whose candidates carry none (criterion 18) has none to
 *    plan and this step does nothing.
 * 5. Entries are fitted until the capacity runs out; the rest become overflow, and a plan that
 *    had to leave something out says so.
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
    // First mention wins, and the check comes before the candidate lookup so it holds whether or
    // not the id resolves. A task planned twice is one task, and the second entry would spend the
    // same capacity again on work that is already in the list; a duplicate invented id is still
    // one invented id, and repeating it should not repeat the warning about it.
    if (seen.has(entry.taskId)) continue
    seen.add(entry.taskId)

    const candidate = byId.get(entry.taskId)
    if (candidate === undefined) {
      warnings.push(
        `The model planned "${entry.taskId}", which is not one of today's tasks, so it was left out.`,
      )
      continue
    }

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

  // Criterion 16. The overflow list is on the screen either way, but a reader is looking at the
  // plan, and "this is all of it" and "this is as much of it as fitted" are different claims. No
  // count and no minutes in it: the list beside it is the count, and a figure written into a
  // sentence is a figure that can come to disagree with the one drawn next to it.
  if (overflow.length > 0) {
    warnings.push(
      "Some of today's work did not fit into the free time left, so it is below rather than in the plan.",
    )
  }

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
 *
 * The queue is the candidate list's own reviews, so criterion 18 needs no branch here: with reviews
 * excluded there are none to find, and this returns the order it was handed. That is deliberate.
 * This is the one rule that could put back a review nobody offered, and excluding them upstream is
 * only a guarantee because this reaches no further than the list.
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
  // capacity line is not in the plan, which is the case criterion 7 is about where reviews are
  // included at all.
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
  // The age and the threshold are `waiting.ts`'s rule, not a second copy of it. The caller has
  // already resolved which moment the wait runs from, so it is handed over as `statusSetAt`
  // with no source: a change to what counts as stale reaches the plan as well as the board.
  const basis = (item: WaitingItem) => ({ statusSetAt: item.waitingSince })

  return items
    .filter((item) => isStaleWait(basis(item), null, now, staleDays))
    .map((item) => {
      const waitingMs = waitingAge(basis(item), null, now)
      return { ...item, waitingMs, waitingDays: Math.floor(waitingMs / DAY_MS) }
    })
    .toSorted((first, second) => first.waitingSince - second.waitingSince)
}

/** A blocked task as the nudge rules see it. The blocker's title is the caller's to resolve. */
export interface BlockedItem {
  readonly taskId: string
  readonly title: string
  readonly dueAt: number | null
  /** When it became blocked, which is what the nudge dates from. */
  readonly blockedSince: number
  /** The blocker's own title, or null where the policy withholds it or the row has gone. */
  readonly blockerTitle: string | null
}

export interface BlockedNudge extends BlockedItem {
  readonly dueAt: number
}

/**
 * The blocked work whose deadline has arrived. Spec 05, criterion 20.
 *
 * Excluding blocked work from the plan and stopping there would make an overdue blocked task
 * vanish, and something vanishing quietly is the failure this is all meant to avoid. So it comes
 * back as a nudge: it names the task and what it is behind, consumes no capacity, and sits beside
 * the chase nudges. A deadline that has arrived on work that cannot start is a decision.
 *
 * Most urgent first, which here is the earliest deadline.
 */
export function blockedNudges(items: readonly BlockedItem[], dueBy: number): BlockedNudge[] {
  return items
    .filter((item): item is BlockedNudge => item.dueAt !== null && item.dueAt <= dueBy)
    .toSorted((first, second) => first.dueAt - second.dueAt)
}

/**
 * What `scheduleDay` needs to know about a plan entry: its estimate, to consume free time, and
 * whether it is already done, since spec 05's placement rule (criteria 21 to 24) treats the two
 * differently. Generic over the entry rather than a concrete type, so a caller with a richer view
 * of a plan entry (the web client's own `PlanEntryView`, at present) can walk its own objects
 * straight through and get them back, without this domain module taking a dependency on a shape
 * that belongs to the client.
 */
export interface SchedulableEntry {
  readonly estimateMinutes: number | null
  readonly done: boolean
}

/** One entry's placement in the day, once its estimate has been walked through the free
 *  intervals in rank order. Null where nothing placed it: an entry that could not be scheduled
 *  still has to render somewhere, just without a time. */
export interface ScheduledEntry<E extends SchedulableEntry = SchedulableEntry> {
  readonly entry: E
  readonly startsAt: number | null
}

/** A stretch of free time nothing was scheduled into, still ahead of the present moment: spec 05,
 *  criterion 23. Long enough that an overflow entry might be offered into it, per issue #47's
 *  "would fit" slack row. `endsAt` as well as `minutes` because the day bar draws the gap from its
 *  instants and the agenda's row reads its length in words: rounding the end out of the minutes
 *  would put the drawing half a minute off the clock. */
export interface SlackGap {
  readonly startsAt: number
  readonly endsAt: number
  readonly minutes: number
}

/** One walk of the plan through the day's free time, rendered twice: as the day bar's track and as
 *  the agenda's clock times. Spec 08, criterion 43. */
export interface DayPlacement<E extends SchedulableEntry = SchedulableEntry> {
  readonly scheduled: readonly ScheduledEntry<E>[]
  readonly gaps: readonly SlackGap[]
}

/**
 * Walks `entries` (rank order) through `freeIntervals` (chronological order), consuming each
 * entry's estimate from wherever the cursor currently sits. An entry too big for what remains of
 * an interval waits for the next one; an entry with no estimate is placed at the cursor without
 * moving it, since there is nothing to consume. Whatever of an interval is left over once entries
 * stop fitting becomes a gap. Entries that never fit anywhere come back with `startsAt: null`
 * rather than being dropped: a plan the walk cannot schedule is still a plan to show.
 *
 * The one pass both of `scheduleDay`'s two calls share: it does not know about "done" or "now",
 * only about a list of entries and the free time offered to them.
 */
function placeInOrder<E extends SchedulableEntry>(
  entries: readonly E[],
  freeIntervals: readonly Interval[],
): { readonly scheduled: readonly ScheduledEntry<E>[]; readonly gaps: readonly SlackGap[] } {
  const scheduled: ScheduledEntry<E>[] = []
  const gaps: SlackGap[] = []
  let index = 0

  for (const interval of freeIntervals) {
    let cursor = interval.start
    let entry = entries[index]
    while (entry !== undefined) {
      const minutes = entry.estimateMinutes ?? 0
      const durationMs = minutes * MINUTE_MS
      // The `durationMs > 0` guard is for the no-estimate case, which is placed at the cursor
      // without moving it. A negative estimate would skip the fit check and rewind the cursor, but
      // cannot arrive: `estimateFor` above floors every entry at one minute.
      if (durationMs > 0 && cursor + durationMs > interval.end) break
      scheduled.push({ entry, startsAt: cursor })
      cursor += durationMs
      index += 1
      entry = entries[index]
    }

    if (cursor < interval.end) {
      gaps.push({
        startsAt: cursor,
        endsAt: interval.end,
        minutes: Math.round((interval.end - cursor) / MINUTE_MS),
      })
    }
  }

  for (let entry = entries[index]; entry !== undefined; index += 1, entry = entries[index]) {
    scheduled.push({ entry, startsAt: null })
  }

  return { scheduled, gaps }
}

/** The minutes a placement actually consumed, as intervals, so they can be taken out of the free
 *  time offered to the next walk. An entry with no estimate, or one the walk could not place,
 *  consumed nothing and contributes no span. */
function placedSpans(scheduled: readonly ScheduledEntry[]): Interval[] {
  const spans: Interval[] = []

  for (const { entry, startsAt } of scheduled) {
    if (startsAt === null) continue
    const minutes = entry.estimateMinutes ?? 0
    if (minutes <= 0) continue
    spans.push({ start: startsAt, end: startsAt + minutes * MINUTE_MS })
  }

  return spans
}

/** `intervals`, with every minute any of `spans` covers removed. Spans are expected to fall
 *  within the intervals they were drawn from, but this holds for an arbitrary span regardless. */
function withoutSpans(intervals: readonly Interval[], spans: readonly Interval[]): Interval[] {
  if (spans.length === 0) return [...intervals]

  const ordered = [...spans].toSorted((first, second) => first.start - second.start)
  const remaining: Interval[] = []

  for (const interval of intervals) {
    let cursor = interval.start
    for (const span of ordered) {
      const start = Math.max(span.start, cursor)
      const end = Math.min(span.end, interval.end)
      if (end <= start) continue
      if (start > cursor) remaining.push({ start: cursor, end: start })
      cursor = Math.max(cursor, end)
    }
    if (cursor < interval.end) remaining.push({ start: cursor, end: interval.end })
  }

  return remaining
}

/** `intervals`, floored at `now`: the part of each interval before `now` is gone, and an interval
 *  entirely before `now` disappears rather than surviving as an empty span. Spec 05, criterion 23. */
function afterNow(intervals: readonly Interval[], now: number): Interval[] {
  const future: Interval[] = []

  for (const interval of intervals) {
    const start = Math.max(interval.start, now)
    if (start < interval.end) future.push({ start, end: interval.end })
  }

  return future
}

/**
 * The day's placement: one walk of `entries` (rank order) through `freeIntervals`, aware of the
 * present moment (`now`, epoch milliseconds) so that work still to be done is never placed behind
 * it. Spec 05, criteria 21 to 24.
 *
 * Completed and outstanding entries are walked separately rather than through one cursor floored
 * at `now`, because a single shared cursor would still get this wrong: ranked ahead of an entry
 * still outstanding, a task already finished would be dragged forward into the future along with
 * it. So:
 *
 * 1. Completed entries (`entry.done`) are walked first, in their own rank order, from the top of
 *    `freeIntervals`, exactly as the whole plan used to be walked before `now` existed. Completed
 *    work is a fact about where it happened, and this walk does not move it.
 * 2. The minutes that walk consumed are taken out of `freeIntervals`, and whatever is left is
 *    floored at `now`. Both cuts have to hold at once, including where a completed entry's own
 *    block straddles `now`: the minutes it consumed are unavailable whichever side of `now` they
 *    fall on, and the minutes before `now` are unavailable whether or not anything used them.
 * 3. Outstanding entries are then walked, in their own rank order, through what that leaves: free
 *    time that is neither already spent nor already gone.
 *
 * Called once per render, by the dashboard rather than by either of the two things that draw it:
 * the day bar positions each entry from this result and the agenda prints a clock time from the
 * same one, which is what makes "the bar and the agenda never disagree about when something is
 * happening" true by construction rather than by two algorithms happening to agree (spec 08,
 * criterion 43). The returned `scheduled` list keeps the entries in their original rank order,
 * whichever of the two walks placed each one.
 *
 * A day with no free intervals at all places nothing and leaves no gaps, which is exactly the
 * unschedulable case: every entry comes back without a time and still renders. With `now` at or
 * before the earliest free interval's start, nothing has elapsed and nothing has been walked away
 * from either walk, so this reduces to the single walk the day used before `now` was taken into
 * account.
 */
export function scheduleDay<E extends SchedulableEntry>(
  entries: readonly E[],
  freeIntervals: readonly Interval[],
  now: number,
): DayPlacement<E> {
  // Original positions rather than the entries themselves, so two entries that happened to be the
  // same object would still each get the placement their own position earned, not whichever walk
  // wrote to the map last.
  const doneAt: number[] = []
  const outstandingAt: number[] = []
  entries.forEach((entry, index) => (entry.done ? doneAt : outstandingAt).push(index))

  const donePlacement = placeInOrder(
    doneAt.map((index) => entries[index] as E),
    freeIntervals,
  )
  const freeAfterDone = withoutSpans(freeIntervals, placedSpans(donePlacement.scheduled))
  const freeAheadOfNow = afterNow(freeAfterDone, now)
  const outstandingPlacement = placeInOrder(
    outstandingAt.map((index) => entries[index] as E),
    freeAheadOfNow,
  )

  const startsAtByIndex = new Map<number, number | null>()
  donePlacement.scheduled.forEach((placed, i) =>
    startsAtByIndex.set(doneAt[i] as number, placed.startsAt),
  )
  outstandingPlacement.scheduled.forEach((placed, i) =>
    startsAtByIndex.set(outstandingAt[i] as number, placed.startsAt),
  )

  return {
    scheduled: entries.map((entry, index) => ({
      entry,
      startsAt: startsAtByIndex.get(index) ?? null,
    })),
    gaps: outstandingPlacement.gaps,
  }
}

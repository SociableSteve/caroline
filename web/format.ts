/**
 * Formatting and the small derivations the surfaces share. Pure functions taking `now` as an
 * argument, so every one of them is testable without a clock and the board and the dashboard
 * cannot disagree about how long something has been waiting.
 */
import { hasNewCommitsSinceActing } from '../src/domain/review.js'
import { instantAt, localDateAt, parseLocalDate } from '../src/domain/time.js'
import {
  isStaleWait,
  waitingAge as waitingAgeOf,
  waitingSince as waitingSinceOf,
} from '../src/domain/waiting.js'
import type { PullRequestMetadata, SourceView, TaskStatus, TaskView } from './api.js'

const statusLabels: Record<TaskStatus, string> = {
  inbox: 'Inbox',
  next_action: 'Next actions',
  review: 'Review',
  waiting: 'Waiting for',
  someday: 'Someday',
  reference: 'Reference',
  done: 'Done',
}

export function statusLabel(status: TaskStatus): string {
  return statusLabels[status]
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Not a duration but a moment, so it is the one age the word "ago" must not be added to. */
const JUST_NOW = 'just now'

/** Human, coarse, and never negative: "3 days", "5 hours", "just now". */
export function formatAge(milliseconds: number): string {
  if (milliseconds < MINUTE) return JUST_NOW
  if (milliseconds < HOUR) return plural(Math.floor(milliseconds / MINUTE), 'minute')
  if (milliseconds < DAY) return plural(Math.floor(milliseconds / HOUR), 'hour')
  return plural(Math.floor(milliseconds / DAY), 'day')
}

/**
 * The same age, said as a time in the past. "3 days ago", and "just now" rather than the
 * "just now ago" that appending the word produced at four separate call sites.
 */
export function formatAgo(milliseconds: number): string {
  const age = formatAge(milliseconds)
  return age === JUST_NOW ? age : `${age} ago`
}

/** How long since a moment, said as a time in the past. Never negative. */
export function ago(from: number, now: number): string {
  return formatAgo(Math.max(0, now - from))
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'}`
}

export function formatDate(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

/**
 * Which side of today a date falls. Spec 10: a date on its own asks the reader to know today's
 * date and do the comparison, so anywhere one is shown the state is named instead.
 *
 * Compared by day rather than by instant, in the reader's own zone, because a task due at nine
 * this morning is due today and not overdue by six hours.
 */
export type DueState = 'overdue' | 'today' | 'later'

export function dueState(dueAt: number, now: number): DueState {
  const startOfToday = new Date(now).setHours(0, 0, 0, 0)
  if (dueAt < startOfToday) return 'overdue'

  // The calendar's next day rather than `startOfToday + DAY`: a local day is not always
  // 86,400,000ms long, and on the two days a year it is not, adding a fixed span puts the
  // boundary an hour inside today or an hour into tomorrow.
  const startOfTomorrow = new Date(startOfToday)
  startOfTomorrow.setDate(startOfTomorrow.getDate() + 1)

  return dueAt < startOfTomorrow.getTime() ? 'today' : 'later'
}

/** A due date with its state named, and the date kept alongside it where there is one to keep. */
export function formatDue(dueAt: number, now: number): string {
  switch (dueState(dueAt, now)) {
    case 'overdue':
      return `Overdue, ${formatDate(dueAt)}`
    case 'today':
      return `Today, ${formatDate(dueAt)}`
    case 'later':
      return formatDate(dueAt)
  }
}

/** A clock time in the reader's own locale. What the calendar column labels a block with. */
export function formatTimeOfDay(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

export function formatEstimate(minutes: number): string {
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? plural(hours, 'hour') : `${plural(hours, 'hour')} ${rest} min`
}

/** Just the parts of a task the waiting derivations read. */
export type Waiting = Pick<TaskView, 'statusSetAt' | 'sources'>

/**
 * How long a waiting item has been waiting, and when that becomes a chase. The rule is spec
 * 02's and lives in `src/domain/waiting.ts`; these resolve the pull request source it is
 * measured from and hand it over, so the card, the dashboard and the daily plan's nudges
 * cannot come to different answers about the same item.
 */
export function waitingSince(task: Waiting): number {
  return waitingSinceOf(task, pullRequestSource(task))
}

export function waitingAge(task: Waiting, now: number): number {
  return waitingAgeOf(task, pullRequestSource(task), now)
}

export function isStale(task: Waiting, now: number, staleDays: number): boolean {
  return isStaleWait(task, pullRequestSource(task), now, staleDays)
}

/** Oldest first: the chase list's whole purpose is the top of it. */
export function byOldestFirst(first: Waiting, second: Waiting): number {
  return waitingSince(first) - waitingSince(second)
}

/**
 * The pull request a task came from, if it came from one. A task has at most one open
 * GitHub source: the connector keys on `(provider, external_id)` and a pull request is one
 * item.
 */
export function pullRequestSource(task: Pick<TaskView, 'sources'>): SourceView | undefined {
  return task.sources.find((source) => source.provider === 'github')
}

/**
 * The items that turned out to be a second telling of this task's work: the GitHub notification
 * email for a pull request already on the board. They carry no task of their own, and the card is
 * where they are accounted for. Suppressing something must not mean it silently vanished. Spec 02.
 */
export function suppressedSources(task: Pick<TaskView, 'sources'>): SourceView[] {
  return task.sources.filter((source) => source.suppressedAt !== null)
}

export function pullRequestMetadata(source: SourceView): PullRequestMetadata {
  return (source.metadata ?? {}) as PullRequestMetadata
}

/**
 * Has the author pushed since you reviewed? The Waiting for column shows this, because a
 * pull request the author has already responded to is a different kind of wait from one
 * they have not touched. Spec 08.
 *
 * The judgement is the state machine's own, imported rather than reimplemented, so the card
 * and the connector cannot come to different conclusions about the same two shas.
 */
export function hasPushedSinceReview(task: Pick<TaskView, 'sources'>): boolean {
  const source = pullRequestSource(task)
  if (source === undefined) return false

  const { headSha, headCommittedAt } = pullRequestMetadata(source)
  if (headSha === undefined) return false

  return hasNewCommitsSinceActing(
    { headSha, headCommittedAt: headCommittedAt ?? null },
    { actedAt: source.actedAt, actedAtMarker: source.actedAtMarker },
  )
}

/**
 * Whether Mark reviewed applies: an open pull request, in Review, that sync still follows.
 * One predicate, so the button on the card and the `r` key on the board cannot come to
 * different answers about the same task. Spec 08, criteria 8 and 9.
 */
export function canMarkReviewed(
  task: Pick<TaskView, 'status' | 'syncTracked' | 'sources'>,
): boolean {
  const source = pullRequestSource(task)

  // Unresolved, because there is nothing left to discharge on a pull request that has
  // already merged or closed: the server refuses it, and offering it would be a lie.
  return (
    task.status === 'review' &&
    task.syncTracked &&
    source !== undefined &&
    source.resolvedAt === null
  )
}

/**
 * Sync proposed completing this task and was not allowed to, because the user had decided
 * its status themselves. The card says so rather than leaving it looking like nothing
 * happened upstream. Spec 02, criterion 4.
 */
export function isCompletionProposed(task: Pick<TaskView, 'sources' | 'status'>): boolean {
  if (task.status === 'done') return false
  return task.sources.some((source) => source.completionProposedAt !== null)
}

/**
 * A source-backed task the user has filed outside its connector's statuses. It stopped
 * moving on its own, and the card says why rather than leaving it a mystery. Spec 08.
 */
export function hasOptedOutOfSync(task: Pick<TaskView, 'sources' | 'syncTracked'>): boolean {
  return task.sources.length > 0 && !task.syncTracked
}

export function isDeferred(task: Pick<TaskView, 'deferUntil'>, now: number): boolean {
  return task.deferUntil !== null && task.deferUntil > now
}

/**
 * The three conversions between an `<input type="date">` value and the instant the API wants,
 * resolved in the deployment's configured `jobs.timezone` (spec 06) rather than the browser's
 * own zone. `dateFrom` (`src/chat/tools/shared.ts`) resolves the same calendar date the same
 * way for the chat tool's `update_task`, so setting a due date from the board and setting the
 * same calendar date from chat land on the same instant regardless of where the browser
 * happens to be relative to where the server is configured.
 */

/** The last local millisecond of the day named, in `timeZone`. A deadline is the end of that day. */
export function dueAtFromDateInput(value: string, timeZone: string): number | null {
  const date = parseLocalDate(value)
  if (date === null) return null

  const startOfDay = instantAt(date, 0, timeZone)
  if (startOfDay === null) return null

  return (instantAt(date, 23 * 60 + 59, timeZone) ?? startOfDay) + 59_999
}

/** The first local millisecond of the day named, in `timeZone`. A deferral lifts at the start of it. */
export function deferUntilFromDateInput(value: string, timeZone: string): number | null {
  const date = parseLocalDate(value)
  if (date === null) return null

  return instantAt(date, 0, timeZone)
}

/** The inverse of both: an instant as the `YYYY-MM-DD` a date input control wants, read in
 *  `timeZone` so a date round-tripped back through either function above lands unchanged. */
export function dateInputValue(epochMs: number, timeZone: string): string {
  const date = localDateAt(epochMs, timeZone)
  const year = String(date.year).padStart(4, '0')
  const month = String(date.month).padStart(2, '0')
  const day = String(date.day).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * A confidence as a percentage. Rounded, because the difference between 0.42 and 0.418 is not
 * something anybody is going to act on, and two decimal places would suggest it is.
 */
export function formatConfidence(confidence: number): string {
  return `${Math.round(Math.min(1, Math.max(0, confidence)) * 100)}%`
}

/** The tasks carrying a suggestion nobody has answered yet. The inbox's own to-do list. */
export function withProposals(tasks: readonly TaskView[]): TaskView[] {
  return tasks.filter((task) => task.proposal !== null)
}

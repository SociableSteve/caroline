/**
 * Formatting and the small derivations the surfaces share. Pure functions taking `now` as an
 * argument, so every one of them is testable without a clock and the board and the dashboard
 * cannot disagree about how long something has been waiting.
 */
import { hasNewCommitsSinceActing } from '../src/domain/review.js'
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

/** Human, coarse, and never negative: "3 days", "5 hours", "just now". */
export function formatAge(milliseconds: number): string {
  if (milliseconds < MINUTE) return 'just now'
  if (milliseconds < HOUR) return plural(Math.floor(milliseconds / MINUTE), 'minute')
  if (milliseconds < DAY) return plural(Math.floor(milliseconds / HOUR), 'hour')
  return plural(Math.floor(milliseconds / DAY), 'day')
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

export function formatEstimate(minutes: number): string {
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? plural(hours, 'hour') : `${plural(hours, 'hour')} ${rest} min`
}

/** Just the parts of a task the waiting derivations read. */
export type Waiting = Pick<TaskView, 'statusSetAt' | 'sources'>

/**
 * How long a waiting item has been waiting. For a pull request that is the source's
 * `acted_at`: the moment you discharged your part and it became the author's turn. An item
 * with no source has no `acted_at`, so the basis is `status_set_at`, which is the same
 * moment said a different way. Spec 02.
 */
export function waitingSince(task: Waiting): number {
  return pullRequestSource(task)?.actedAt ?? task.statusSetAt
}

export function waitingAge(task: Waiting, now: number): number {
  return Math.max(0, now - waitingSince(task))
}

/** Past the configured threshold, a waiting item stops being tracked and becomes a chase. */
export function isStale(task: Waiting, now: number, staleDays: number): boolean {
  return waitingAge(task, now) >= staleDays * DAY
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

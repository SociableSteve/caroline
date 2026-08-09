/**
 * Formatting and the small derivations the surfaces share. Pure functions taking `now` as an
 * argument, so every one of them is testable without a clock and the board and the dashboard
 * cannot disagree about how long something has been waiting.
 */
import type { TaskStatus, TaskView } from './api.js'

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

/**
 * How long a waiting item has been waiting. `statusSetAt` is the basis: the moment it became
 * somebody else's turn. For a pull request that will become the source's `acted_at`, which
 * arrives with the GitHub connector in M3.
 */
export function waitingSince(task: Pick<TaskView, 'statusSetAt'>): number {
  return task.statusSetAt
}

export function waitingAge(task: Pick<TaskView, 'statusSetAt'>, now: number): number {
  return Math.max(0, now - waitingSince(task))
}

/** Past the configured threshold, a waiting item stops being tracked and becomes a chase. */
export function isStale(
  task: Pick<TaskView, 'statusSetAt'>,
  now: number,
  staleDays: number,
): boolean {
  return waitingAge(task, now) >= staleDays * DAY
}

/** Oldest first: the chase list's whole purpose is the top of it. */
export function byOldestFirst(
  first: Pick<TaskView, 'statusSetAt'>,
  second: Pick<TaskView, 'statusSetAt'>,
): number {
  return waitingSince(first) - waitingSince(second)
}

export function isDeferred(task: Pick<TaskView, 'deferUntil'>, now: number): boolean {
  return task.deferUntil !== null && task.deferUntil > now
}

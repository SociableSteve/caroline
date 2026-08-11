/**
 * What the tools share: how a date argument is read, how an instant is said to a model, and the
 * one summary of a task every tool answers with, so two tools cannot describe the same task
 * differently.
 */
import { withholdsItemText } from '../../config/content.js'
import { getProject } from '../../db/repositories/projects.js'
import type { Task } from '../../domain/task.js'
import { formatLocalDate, instantAt, localDateAt, parseLocalDate } from '../../domain/time.js'
import type { LocalDate } from '../../domain/time.js'
import type { ChatToolContext } from '../types.js'

/** The most rows one tool call will return. A model does not read a hundred titles usefully. */
export const MAX_ROWS = 50

/**
 * Whether this call may answer with an item's own text at all, asked of the content policy rather
 * than decided here: one question, so a level that withholds a title from one tool cannot hand it
 * over from another. Spec 09, criterion 13.
 */
export function withholdsText(context: ChatToolContext): boolean {
  return withholdsItemText(context.config.privacy)
}

/** A local date, with the two instants that bound it in the configured zone. */
export interface DayArgument {
  readonly date: LocalDate
  readonly text: string
  readonly startOfDay: number
  readonly endOfDay: number
}

/**
 * The date a call is about, defaulting to today. Null when the text is not a date: `2026-02-30`
 * passes a pattern and names no day, and a tool that quietly planned the first of March instead
 * would be answering a question nobody asked.
 */
export function dateFrom(context: ChatToolContext, raw: string | undefined): DayArgument | null {
  const timeZone = context.config.jobs.timezone
  const date = raw === undefined ? localDateAt(context.now, timeZone) : parseLocalDate(raw)
  if (date === null) return null

  const startOfDay = instantAt(date, 0, timeZone)
  if (startOfDay === null) return null

  // A minute before the next midnight, which is what "by the end of that day" means. Taken from
  // the day rather than from the working window: a deadline at eight in the evening is still that
  // day's, on a day that stops working at half past five.
  const endOfDay = (instantAt(date, 23 * 60 + 59, timeZone) ?? startOfDay) + 59_999

  return { date, text: formatLocalDate(date), startOfDay, endOfDay }
}

/** An instant as text a model can reason about. Null stays null: absent is a fact. */
export function asIso(epoch: number | null): string | null {
  return epoch === null ? null : new Date(epoch).toISOString()
}

/**
 * A duration in plain words. Used where a number of minutes is the answer to a question a person
 * asked, so that the model does not have to render "437" as anything.
 */
export function describeDuration(minutes: number): string {
  if (minutes < 0) return `${describeDuration(-minutes)} over`
  if (minutes < 60) return `${minutes} minutes`

  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  const hourPart = `${hours} ${hours === 1 ? 'hour' : 'hours'}`

  return rest === 0 ? hourPart : `${hourPart} ${rest} minutes`
}

/** One task as every tool describes it. The notes are left to `get_task`, which is the detail. */
export function taskSummary(context: ChatToolContext, task: Task) {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    projectId: task.projectId,
    project:
      task.projectId === null
        ? null
        : (getProject(context.database, task.projectId)?.title ?? null),
    estimateMinutes: task.estimateMinutes,
    dueAt: asIso(task.dueAt),
    deferUntil: asIso(task.deferUntil),
    waitingOn: task.waitingOn,
    updatedAt: asIso(task.updatedAt),
  }
}

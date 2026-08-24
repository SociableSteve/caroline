/**
 * What the classifier proposes, and the rules that decide what becomes of a proposal. Pure:
 * no clock, no database, no model. Spec 04.
 */
import { taskStatuses, type TaskStatus } from './task.js'

/**
 * The statuses a model may propose: the eight, less `done` and `blocked`. Completing something
 * is a human act, or a fact reported by sync, and a blocker is the user naming one task in front
 * of another (spec 01), so a proposal of either is a validation failure rather than a decision to
 * weigh. Spec 04, criterion 4.
 *
 * `blocked` would mean sending the model the titles and ids of every other task so it could pick
 * one, which is a much larger payload than spec 04's and a content question nobody has asked.
 */
const unproposableStatuses: readonly TaskStatus[] = ['done', 'blocked']

export const proposableStatuses: readonly TaskStatus[] = taskStatuses.filter(
  (status) => !unproposableStatuses.includes(status),
)

/** A project the model thinks this belongs to. Never applied automatically. Spec 04. */
export interface ProjectSuggestion {
  readonly existingProjectId: string | null
  readonly newProjectTitle: string | null
}

/** One answer about one task, as the model gave it and the schema accepted it. */
export interface ClassificationProposal {
  readonly status: TaskStatus
  readonly confidence: number
  readonly reasoning: string
  /** Action-phrased, and only applied where the user has not retitled the task themselves. */
  readonly suggestedTitle: string | null
  readonly estimateMinutes: number | null
  /** Required when the status is `waiting`: a chase list that does not name anyone is not one. */
  readonly waitingOn: string | null
  readonly projectSuggestion: ProjectSuggestion | null
}

/** A row of the audit trail. Every answer writes one, applied or not, failed or not. */
export interface Classification {
  readonly id: string
  readonly taskId: string
  /** Null exactly when the call failed, in which case `error` says how. */
  readonly proposedStatus: TaskStatus | null
  readonly confidence: number | null
  readonly reasoning: string | null
  readonly suggestedTitle: string | null
  readonly estimateMinutes: number | null
  readonly waitingOn: string | null
  readonly projectSuggestion: ProjectSuggestion | null
  readonly provider: string | null
  readonly model: string | null
  readonly promptVersion: string
  /** True when the confidence met the threshold and the status was set. */
  readonly applied: boolean
  readonly acceptedAt: number | null
  readonly dismissedAt: number | null
  readonly error: string | null
  readonly createdAt: number
}

/**
 * A proposal awaiting the user: below the threshold when it was made, and neither accepted nor
 * dismissed since. This is what the UI calls `needs_review`, derived rather than stored, so
 * there is no second copy of the fact to fall out of step with the row it came from.
 */
export function isPending(classification: Classification): boolean {
  return (
    classification.error === null &&
    !classification.applied &&
    classification.acceptedAt === null &&
    classification.dismissedAt === null
  )
}

/**
 * Whether the answer is confident enough to act on. At or above, not merely above: a threshold
 * of 0.75 and an answer of exactly 0.75 is the case a self-hoster tuning the number will try
 * first, and it should mean what it looks like. Spec 04.
 */
export function isConfident(confidence: number, threshold: number): boolean {
  return confidence >= threshold
}

/**
 * Whether the suggested title may replace the task's own. It may, only while the title is
 * still the one the item arrived with: a title the user has rewritten is a decision, and spec
 * 04 does not let the classifier overrule one.
 *
 * The comparison against the source's title is what stands in for an edit flag. A task with no
 * source was typed by the user, title and all, so nothing about it is the classifier's to
 * rewrite.
 */
export function mayRetitle(taskTitle: string, sourceTitle: string | null): boolean {
  return sourceTitle !== null && taskTitle === sourceTitle
}

/**
 * The original title, kept in the notes when the classifier rewrites it, so that the thing the
 * item was actually called is never lost. Idempotent: a second run over the same task does not
 * add a second copy.
 */
export function notesWithOriginalTitle(notes: string | null, originalTitle: string): string {
  const line = `Original title: ${originalTitle}`
  if (notes === null || notes.trim() === '') return line
  return notes.includes(line) ? notes : `${notes}\n\n${line}`
}

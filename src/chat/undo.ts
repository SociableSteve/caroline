/**
 * Undo, as spec 07 defines it: the stored inverse of a turn's mutation batch, applied in reverse,
 * not a rewind of history. Criterion 5 is that undoing a turn restores the prior values of every
 * task it changed, which is what a batch of whole-row restores does.
 *
 * Only the last turn that changed anything can be undone. That is the spec's wording ("the last
 * mutation batch of a turn") and it is also the only version that is safe: an inverse holds the
 * values as they were at the time, so replaying an older one over a task that has moved on since
 * would not be an undo, it would be a quiet revert of everything after it.
 */
import { withTransaction, type Database } from '../db/connection.js'
import {
  inversesFor,
  lastChangedMessageId,
  listChanges,
  markChangeUndone,
  type ChatChangeRecord,
} from '../db/repositories/chat.js'
import { relinkPlanEntry } from '../db/repositories/daily-plans.js'
import { deleteProject, restoreProject } from '../db/repositories/projects.js'
import { relinkSource, restoreSourceLifecycle } from '../db/repositories/sources.js'
import { deleteTask, restoreTask, setTaskTags } from '../db/repositories/tasks.js'
import type { ChatInverse } from '../domain/chat.js'
import { projectFromSnapshot, taskFromSnapshot } from './snapshot.js'

export type UndoResult =
  | { readonly undone: true; readonly changes: readonly ChatChangeRecord[] }
  | { readonly undone: false; readonly reason: UndoRefusal }

export type UndoRefusal =
  /**
   * The turn changed nothing, its changes have been undone already, or there is no such turn: from
   * here they are the same answer, because a turn with nothing to undo and a turn that does not
   * exist both leave the conversation exactly as it is.
   */
  | 'nothing-to-undo'
  /** A later change has happened since, so this batch is no longer the last one. */
  | 'not-the-last-turn'

/**
 * Undoes one turn. Everything in one transaction: half an undo would leave the data in a state
 * neither the turn nor the user asked for.
 */
export function undoTurn(
  database: Database,
  conversationId: string,
  messageId: string,
  now: number,
): UndoResult {
  const last = lastChangedMessageId(database, conversationId)
  if (last === null) return { undone: false, reason: 'nothing-to-undo' }
  if (last !== messageId) return { undone: false, reason: 'not-the-last-turn' }

  const inverses = inversesFor(database, messageId)
  if (inverses.length === 0) return { undone: false, reason: 'nothing-to-undo' }

  return withTransaction(database, () => {
    // Reverse order: a turn that created a project and then filed a task into it has to unfile the
    // task before the project goes, or the restore would write a task pointing at nothing.
    for (const stored of [...inverses].reverse()) {
      for (const operation of [...stored.operations].reverse()) {
        apply(database, operation)
      }
      markChangeUndone(database, stored.changeId, now)
    }

    // The records as they now stand, so the caller renders the batch as undone rather than
    // rebuilding it from what it asked for.
    return { undone: true, changes: listChanges(database, messageId) }
  })
}

/**
 * One inverse operation. A snapshot that does not read back as a row is skipped rather than
 * written: it is Caroline's own JSON and should always be one, and writing a half-understood row
 * into `tasks` would be a worse outcome than an undo that could not finish.
 */
function apply(database: Database, operation: ChatInverse): void {
  if (operation.kind === 'restore-task') {
    const task = taskFromSnapshot(operation.task)
    if (task === null) return

    restoreTask(database, task)
    setTaskTags(database, task.id, operation.tags)
    // Only where the change cleared them, which is a delete. An edit never touched the links, and
    // reasserting them would be a write nobody asked for.
    for (const sourceId of operation.sourceIds ?? []) relinkSource(database, sourceId, task.id)
    for (const entryId of operation.planEntryIds ?? []) relinkPlanEntry(database, entryId, task.id)
    return
  }

  if (operation.kind === 'delete-task') {
    deleteTask(database, operation.id)
    return
  }

  if (operation.kind === 'restore-project') {
    const project = projectFromSnapshot(operation.project)
    if (project !== null) restoreProject(database, project)
    return
  }

  if (operation.kind === 'delete-project') {
    deleteProject(database, operation.id)
    return
  }

  restoreSourceLifecycle(database, operation.id, {
    lifecycleState: operation.lifecycleState,
    actedAt: operation.actedAt,
    actedAtMarker: operation.actedAtMarker,
  })
}

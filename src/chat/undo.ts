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
        apply(database, operation, now)
      }
      markChangeUndone(database, stored.changeId, now)
    }

    // The records as they now stand, so the caller renders the batch as undone rather than
    // rebuilding it from what it asked for.
    return { undone: true, changes: listChanges(database, messageId) }
  })
}

/**
 * One inverse operation. A snapshot that does not read back as a row raises rather than being
 * skipped: it is Caroline's own JSON and should always be one, and the two ways of being wrong about
 * that are not equal. Writing a half-understood row into `tasks` is worse than an undo that could
 * not finish, and marking a change undone without undoing it is worse still, because the batch is
 * then unretryable and the task keeps what the turn wrote. Raising inside the transaction rolls the
 * whole undo back and leaves the batch exactly as it was.
 */
function apply(database: Database, operation: ChatInverse, at: number): void {
  if (operation.kind === 'restore-task') {
    const task = taskFromSnapshot(operation.task)
    if (task === null) {
      throw new Error(`the stored snapshot of a task could not be read back, so nothing was undone`)
    }

    restoreTask(database, task)
    setTaskTags(database, task.id, operation.tags)
    /*
     * Only where the change cleared them, which is a delete. An edit never touched the links, and
     * reasserting them would be a write nobody asked for.
     *
     * A link whose row has gone is tolerated, unlike the lifecycle restore below: the source or the
     * plan entry is the thing that would hold the link, so if it is not there there is no link to
     * put back and nothing about the restored task is wrong. The lifecycle restore is the other half
     * of a move, which is a different matter.
     */
    for (const sourceId of operation.sourceIds ?? []) relinkSource(database, sourceId, task.id)
    for (const entryId of operation.planEntryIds ?? []) relinkPlanEntry(database, entryId, task.id)
    return
  }

  if (operation.kind === 'delete-task') {
    deleteTask(database, operation.id, at)
    return
  }

  if (operation.kind === 'restore-project') {
    const project = projectFromSnapshot(operation.project)
    if (project === null) {
      throw new Error(
        `the stored snapshot of a project could not be read back, so nothing was undone`,
      )
    }

    restoreProject(database, project)
    return
  }

  if (operation.kind === 'delete-project') {
    deleteProject(database, operation.id)
    return
  }

  if (operation.kind === 'restore-source-lifecycle') {
    const restored = restoreSourceLifecycle(database, operation.id, {
      lifecycleState: operation.lifecycleState,
      actedAt: operation.actedAt,
      actedAtMarker: operation.actedAtMarker,
    })

    /*
     * This half is not optional. Undoing a mark-reviewed means putting the task back *and* putting
     * the connector's state machine back; with only the first, the next sync fifteen minutes later
     * reads a review that never happened as discharged. So a source that is not there to restore
     * fails the undo rather than being stamped as done, for the same reason an unreadable snapshot
     * does. Nothing in Caroline deletes a source row today, which makes this a guard rather than a
     * case, and a guard is what it should be either way.
     */
    if (restored === null) {
      throw new Error(
        `the source ${operation.id} named by a stored inverse no longer exists, so nothing was undone`,
      )
    }
    return
  }

  // Named rather than left as the last `else`, so a kind added to `ChatInverse` later fails to
  // compile here instead of being silently applied as whatever this branch happened to be.
  const unhandled: never = operation
  throw new Error(`unknown inverse operation: ${JSON.stringify(unhandled)}`)
}

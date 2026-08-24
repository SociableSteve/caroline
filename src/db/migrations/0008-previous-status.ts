import type { Migration } from '../migrate.js'

/**
 * What putting a board move back needs: what the status and its actor were immediately before the
 * most recent change. Spec 01, status.
 *
 * The actor is the reason this exists. A board move is one unconfirmed gesture and records
 * `status_set_by = 'user'`, which takes the task out of the classifier's reach for good, so
 * restoring the status alone would leave the undo having missed the part that mattered.
 */
export const previousStatus: Migration = {
  id: 8,
  name: 'previous status',
  up(database) {
    // Nullable, and null on every existing row: a task never changed since creation has nothing
    // to put back, which is exactly what these two being null says.
    database.exec('alter table tasks add column previous_status text')
    database.exec('alter table tasks add column previous_status_set_by text')
  },
}

import type { Migration } from '../migrate.js'

/**
 * Blocking one task behind another. Spec 01, "Blocking".
 *
 * Two changes to `tasks`, and both of them need the table rebuilt: `blocked` is an eighth value
 * in the status check, and the invariant that ties it to the new reference is a table check of
 * its own. SQLite cannot alter a check constraint in place, so this is the twelve-step rebuild
 * from its own documentation, which is why the migration declares `withoutForeignKeys`. Nothing
 * in the tree had rebuilt a table before this one.
 *
 * The status list is written out literally, as migration 0001 writes it, because a migration is a
 * frozen historical record: reading a live constant would rewrite what already ran on every
 * existing database. `test/db/schema.test.ts` asserts the two stay in step.
 */
export const blockedBy: Migration = {
  id: 15,
  name: 'blocked by',
  // The rebuild drops `tasks`, and a drop with foreign keys on runs an implicit delete that would
  // cascade `task_tags` and `classifications` away and null every `sources.task_id`. The pragma is
  // a no-op inside a transaction, so the runner has to set it around this one.
  withoutForeignKeys: true,
  up(database) {
    database.exec(`
      create table tasks_rebuilt (
        id text primary key,
        title text not null,
        notes text,
        status text not null check (
          status in (
            'inbox', 'next_action', 'review', 'waiting', 'blocked', 'someday', 'reference', 'done'
          )
        ),
        project_id text references projects (id) on delete set null,
        sort_order integer not null default 0,
        estimate_minutes integer,
        due_at integer,
        defer_until integer,
        waiting_on text,
        -- Deleting a blocker leaves nothing pointing at a row that has gone. It is not sufficient
        -- on its own: nulling the reference alone would leave the status saying 'blocked', which
        -- the check below forbids, so the repository moves the dependents in the same transaction
        -- as the delete. Spec 01, criterion 15.
        blocked_by text references tasks (id) on delete set null,
        status_set_by text not null check (status_set_by in ('user', 'llm', 'sync')),
        status_set_at integer not null,
        previous_status text,
        previous_status_set_by text,
        sync_tracked integer not null default 0 check (sync_tracked in (0, 1)),
        created_at integer not null,
        updated_at integer not null,
        completed_at integer,
        -- The status and the reference are one fact. Written here rather than remembered by every
        -- write path, so the disagreement is impossible rather than merely avoided. Spec 01,
        -- criterion 12.
        check ((status = 'blocked') = (blocked_by is not null))
      )
    `)

    database.exec(`
      insert into tasks_rebuilt (
        id, title, notes, status, project_id, sort_order, estimate_minutes, due_at, defer_until,
        waiting_on, blocked_by, status_set_by, status_set_at, previous_status,
        previous_status_set_by, sync_tracked, created_at, updated_at, completed_at
      )
      select
        id, title, notes, status, project_id, sort_order, estimate_minutes, due_at, defer_until,
        waiting_on, null, status_set_by, status_set_at, previous_status,
        previous_status_set_by, sync_tracked, created_at, updated_at, completed_at
      from tasks
    `)

    database.exec('drop table tasks')
    database.exec('alter table tasks_rebuilt rename to tasks')

    database.exec('create index tasks_status on tasks (status)')
    database.exec('create index tasks_project_id on tasks (project_id)')
    database.exec('create index tasks_defer_until on tasks (defer_until)')
    // Releasing what a blocker was in front of is a lookup by the reference rather than by the id,
    // and it runs on every completion and every delete.
    database.exec('create index tasks_blocked_by on tasks (blocked_by)')

    // Step ten of the rebuild, and inside the transaction so a failure rolls the whole of it back
    // rather than leaving a database whose keys no longer resolve.
    const violations = database.prepare('pragma foreign_key_check').all()
    if (violations.length > 0) {
      throw new Error(
        `rebuilding tasks left ${violations.length} foreign key violations behind, so it was rolled back`,
      )
    }
  },
}

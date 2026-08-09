import type { Migration } from '../migrate.js'

/**
 * Projects, tasks, tags and sources. Spec 01.
 *
 * The status and state lists are written out literally rather than generated from
 * `src/domain`, because a migration is a frozen historical record: if it read a live
 * constant, changing that constant would rewrite what already ran on every existing
 * database. `test/db/schema.test.ts` asserts the two stay in step, so drift fails a test
 * instead of silently rewriting history.
 */
export const initial: Migration = {
  id: 1,
  name: 'initial task model',
  up(database) {
    database.exec(`
      create table projects (
        id text primary key,
        title text not null,
        notes text,
        state text not null check (state in ('active', 'someday', 'done', 'dropped')),
        created_at integer not null,
        updated_at integer not null,
        completed_at integer
      )
    `)

    database.exec(`
      create table tasks (
        id text primary key,
        title text not null,
        notes text,
        status text not null check (
          status in ('inbox', 'next_action', 'review', 'waiting', 'someday', 'reference', 'done')
        ),
        -- Deleting a project orphans its tasks rather than taking them with it. Spec 01,
        -- criterion 6. This only holds with 'pragma foreign_keys = ON', which
        -- 'openDatabase' sets on every connection.
        project_id text references projects (id) on delete set null,
        sort_order integer not null default 0,
        estimate_minutes integer,
        due_at integer,
        defer_until integer,
        waiting_on text,
        status_set_by text not null check (status_set_by in ('user', 'llm', 'sync')),
        status_set_at integer not null,
        sync_tracked integer not null default 0 check (sync_tracked in (0, 1)),
        created_at integer not null,
        updated_at integer not null,
        completed_at integer
      )
    `)

    database.exec('create index tasks_status on tasks (status)')
    database.exec('create index tasks_project_id on tasks (project_id)')
    database.exec('create index tasks_defer_until on tasks (defer_until)')

    // Tags are a join table, not a delimited string, so they can be queried and counted.
    database.exec(`
      create table task_tags (
        task_id text not null references tasks (id) on delete cascade,
        tag text not null,
        primary key (task_id, tag)
      )
    `)

    database.exec('create index task_tags_tag on task_tags (tag)')

    database.exec(`
      create table sources (
        id text primary key,
        provider text not null check (provider in ('github', 'gmail', 'gcal')),
        external_id text not null,
        url text,
        title text,
        metadata text,
        content text,
        content_hash text,
        -- A deleted task leaves its source behind: the row is the record that this item
        -- has already been seen, and losing it would let sync capture the item again.
        task_id text references tasks (id) on delete set null,
        first_seen_at integer not null,
        last_seen_at integer not null,
        resolved_at integer,
        lifecycle_state text,
        acted_at integer,
        acted_at_marker text
      )
    `)

    // The dedupe key for the whole sync engine. Spec 01, criterion 3.
    database.exec(
      'create unique index sources_provider_external_id on sources (provider, external_id)',
    )
    database.exec('create index sources_task_id on sources (task_id)')
  },
}

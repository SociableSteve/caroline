import type { Migration } from '../migrate.js'

/**
 * What the sync engine needs beyond the task model: somewhere to record what each run did,
 * somewhere to keep each connector's incremental cursor, and two more facts about a source.
 * Specs 02 and 06.
 *
 * As in `0001`, the allowed values are written out literally rather than read from
 * `src/domain`, because a migration is a frozen historical record. `test/db/schema.test.ts`
 * asserts the two stay in step.
 */
export const syncEngine: Migration = {
  id: 2,
  name: 'sync engine',
  up(database) {
    // When an upstream content change put this source's task back in the classification
    // queue. Only inbox tasks are ever requeued, so a triaged task is never disturbed by a
    // change upstream. Spec 02, criterion 2.
    database.exec('alter table sources add column requeued_at integer')

    // When sync proposed completing the linked task. A proposal, not the act: an open item
    // is never completed by sync, and a closed one whose task the user has since edited is
    // left for them to finish. Spec 02, criterion 4.
    database.exec('alter table sources add column completion_proposed_at integer')

    // The refresh pass reads every unresolved source of a provider on every run, so the
    // index it walks is worth having from the start.
    database.exec('create index sources_provider_resolved_at on sources (provider, resolved_at)')

    // One row per attempt, written when the attempt ends: a run in flight is held in
    // process, so there is no half-written row for a crash to leave behind. Spec 06.
    database.exec(`
      create table job_runs (
        id text primary key,
        job text not null,
        trigger text not null check (trigger in ('scheduled', 'manual', 'startup')),
        started_at integer not null,
        finished_at integer not null,
        status text not null check (status in ('success', 'failure', 'skipped')),
        counts text,
        error text,
        error_stack text
      )
    `)

    database.exec('create index job_runs_job on job_runs (job, started_at)')

    // The `since` cursor spec 02 asks be persisted per connector. Providers that cannot do
    // an incremental fetch simply never read it.
    database.exec(`
      create table sync_state (
        provider text primary key check (provider in ('github', 'gmail', 'gcal')),
        cursor integer,
        updated_at integer not null
      )
    `)
  },
}

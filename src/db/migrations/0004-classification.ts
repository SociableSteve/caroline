import type { Migration } from '../migrate.js'

/**
 * What classification needs beyond the task model: an audit row per answer, and two facts
 * about a source's stored body so that the retention and downgrade purges can tell what they
 * are looking at. Specs 04 and 09.
 *
 * As in the earlier migrations, the allowed values are written out literally rather than read
 * from `src/domain`, because a migration is a frozen historical record. `test/db/schema.test.ts`
 * asserts the two stay in step.
 */
export const classification: Migration = {
  id: 4,
  name: 'classification',
  up(database) {
    // Which policy level the stored body was written under. Without it, lowering
    // `storeContent` could not tell a snippet it should keep from a full body it should cut
    // back: the text alone does not say which it is. Spec 09, criterion 4.
    database.exec("alter table sources add column content_level text not null default 'none'")

    // When the stored body was written, which is what retention is measured from. Not
    // `last_seen_at`: a thread that is still in the inbox is seen every fifteen minutes, and
    // measuring from that would mean a body was never old enough to purge. Spec 09, criterion 5.
    database.exec('alter table sources add column content_stored_at integer')

    /*
     * One row per answer, applied or not, including the ones that failed. Spec 04, criterion 6:
     * this is the audit trail and the evaluation set, so a run that could not reach the
     * provider leaves a record of having tried rather than a silence.
     *
     * `done` is absent from the allowed statuses on purpose. Completing something is a human
     * act, or a fact reported by sync, so a model proposing it is a validation failure and
     * never reaches a row. Spec 04, criterion 4.
     */
    database.exec(`
      create table classifications (
        id text primary key,
        task_id text not null references tasks (id) on delete cascade,
        proposed_status text check (
          proposed_status in ('inbox', 'next_action', 'review', 'waiting', 'someday', 'reference')
        ),
        confidence real check (confidence >= 0 and confidence <= 1),
        reasoning text,
        suggested_title text,
        estimate_minutes integer,
        waiting_on text,
        -- The model's project suggestion, as JSON. Never applied automatically: creating a
        -- project is a commitment, so it surfaces as a suggestion. Spec 04.
        project_suggestion text,
        provider text,
        model text,
        -- Which version of the prompt produced this, so a change in behaviour is traceable to
        -- a change in what was asked. Spec 04.
        prompt_version text not null,
        applied integer not null check (applied in (0, 1)),
        -- When the user accepted or dismissed a proposal that was below the threshold. A row
        -- with neither, and applied = 0, is the one the UI is waiting on.
        accepted_at integer,
        dismissed_at integer,
        error text,
        created_at integer not null,
        -- A row is either an answer or a failure, never both and never neither: a row with no
        -- proposal and no error would be a record that says nothing happened.
        check ((proposed_status is null) = (error is not null)),
        check ((proposed_status is null) = (confidence is null)),
        -- An applied row is one the model answered, and an accepted one is a proposal that was
        -- not applied. Both being true would mean the status was set twice by two rules.
        check (not (applied = 1 and accepted_at is not null)),
        check (not (applied = 1 and error is not null))
      )
    `)

    // The two questions asked of this table: what is pending for this task, and what did the
    // classifier decide lately.
    database.exec('create index classifications_task on classifications (task_id, created_at)')
    database.exec('create index classifications_created_at on classifications (created_at)')
  },
}

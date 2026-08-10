import type { Migration } from '../migrate.js'

/**
 * Chat: the conversations, what each turn changed, and the operations a turn proposed but was
 * not allowed to carry out on its own. Spec 07.
 *
 * As in the earlier migrations, the allowed values are written out literally rather than read
 * from `src/domain`, because a migration is a frozen historical record. `test/db/schema.test.ts`
 * asserts the two stay in step.
 */
export const chat: Migration = {
  id: 6,
  name: 'chat',
  up(database) {
    /*
     * A conversation. The title is taken from the first thing the user said, because a
     * conversation is found again by remembering what it was about, and nothing else here knows
     * what it was about.
     */
    database.exec(`
      create table chat_conversations (
        id text primary key,
        title text not null,
        created_at integer not null,
        updated_at integer not null
      )
    `)

    // The list is read newest first, and that is the only question asked of the table.
    database.exec(
      'create index chat_conversations_recent on chat_conversations (updated_at desc, id)',
    )

    /*
     * One row per turn. Only what was said is kept: the tool calls a turn made and the results
     * they returned are not, because spec 07 has the model fetch task detail through tools on
     * every turn rather than reading it out of the transcript. Replaying yesterday's tool
     * results would be feeding it yesterday's data.
     *
     * The counts and the token usage belong to an assistant turn, so a user turn is constrained
     * to hold none of them: a row saying the user spent tokens would be a row nothing could act
     * on and the usage total would be wrong by however much it claimed.
     */
    database.exec(`
      create table chat_messages (
        id text primary key,
        conversation_id text not null references chat_conversations (id) on delete cascade,
        -- Position within the conversation, from one. Ordering by time would leave two messages
        -- written in the same millisecond in whichever order the read happened to return.
        seq integer not null check (seq >= 1),
        role text not null check (role in ('user', 'assistant')),
        content text not null,
        created_at integer not null,
        tool_calls integer not null default 0 check (tool_calls >= 0),
        -- The turn stopped because it ran out of its tool-call budget rather than because it had
        -- finished. Spec 07, criterion 6: it says so, and what it already did stands.
        tool_call_limit_reached integer not null default 0
          check (tool_call_limit_reached in (0, 1)),
        -- The turn was answered by a model that cannot use tools, so no change was possible.
        -- Criterion 7: recorded on the turn, so a transcript read later still says why.
        read_only integer not null default 0 check (read_only in (0, 1)),
        input_tokens integer not null default 0 check (input_tokens >= 0),
        output_tokens integer not null default 0 check (output_tokens >= 0),
        stop_reason text,
        -- What went wrong, for a turn that failed part-way. The text that did arrive is kept
        -- beside it: a turn that streamed three sentences and then lost the provider said those
        -- three sentences, and blanking them would be a second inaccuracy on top of the first.
        error text,
        -- One turn per position. The unique index this creates is also the one every read of a
        -- conversation uses, so there is no second index on the same two columns.
        unique (conversation_id, seq),
        check (
          role = 'assistant' or (
            tool_calls = 0 and tool_call_limit_reached = 0 and read_only = 0
            and input_tokens = 0 and output_tokens = 0
            and stop_reason is null and error is null
          )
        )
      )
    `)

    /*
     * What a turn changed, one row per mutation, in the order they happened. Two things read
     * this: the transcript, which renders the compact record spec 07 asks for, and undo.
     *
     * `inverse` is the stored inverse operation, as JSON. Spec 07 is explicit that undo is an
     * inverse and not a history rewind, so what it takes to put a thing back is decided and
     * written at the moment of the change, when the previous values are still there to read.
     * Null where there is nothing to undo: redrawing a plan is a new plan, and the previous one
     * stays in history either way.
     */
    database.exec(`
      create table chat_changes (
        id text primary key,
        -- The turn, which is the unit undo works in. Going with the turn is right: a record of a
        -- change to a task, belonging to a message nobody can read, is not a record of anything.
        message_id text not null references chat_messages (id) on delete cascade,
        position integer not null check (position >= 1),
        tool text not null,
        -- What changed, in the words the transcript shows. Written once, so the record reads the
        -- same later as it did on the day even if the task has moved on since.
        summary text not null,
        entity text not null check (entity in ('task', 'project', 'plan')),
        entity_id text,
        inverse text,
        created_at integer not null,
        undone_at integer,
        -- One change per position in a turn. As above, this index is the one the reads use.
        unique (message_id, position)
      )
    `)

    /*
     * An operation the model proposed and did not perform: a delete, or a write past the point
     * where a turn has changed more tasks than the configured threshold. Spec 07: the model
     * proposes, the user confirms, and nothing happens in between.
     *
     * The arguments are kept as the JSON the tool validated, so confirming runs the operation
     * the user was shown rather than one rebuilt from a summary of it.
     */
    database.exec(`
      create table chat_confirmations (
        id text primary key,
        message_id text not null references chat_messages (id) on delete cascade,
        reason text not null check (reason in ('delete', 'bulk')),
        tool text not null,
        arguments text not null,
        -- How many items confirming would affect. Criterion 4 asks the confirmation state this,
        -- so it is stored rather than counted at render time against data that has since moved.
        affected_count integer not null check (affected_count >= 1),
        summary text not null,
        created_at integer not null,
        decided_at integer,
        decision text check (decision in ('confirmed', 'rejected')),
        -- Decided and undecided are one fact, not two. A row with a decision and no moment, or a
        -- moment and no decision, would be a confirmation nothing could report the state of.
        check ((decided_at is null) = (decision is null))
      )
    `)

    database.exec(
      'create index chat_confirmations_message on chat_confirmations (message_id, created_at)',
    )
  },
}

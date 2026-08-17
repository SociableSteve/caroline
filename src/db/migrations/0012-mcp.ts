import type { Migration } from '../migrate.js'

/**
 * The MCP server, slice 2. Spec 12.
 *
 * `chat_conversations` gains the source that says which kind of caller it belongs to, and the
 * name of the client for an MCP one, so the two show up differently in the conversation list
 * (spec 08) without a second table for what is still one conversation.
 *
 * `mcp_sessions` is Caroline's own derived session (spec 12, "The session, which the protocol no
 * longer has"): the protocol carries no session identifier, so a session is one client's run of
 * calls, found by its declared name and continued while they keep arriving inside the idle
 * window. It also carries the turn a session's writes accumulate against, because a turn spans
 * many separate JSON-RPC calls rather than one request the way a browser turn does:
 * `current_turn_message_id` is the open turn's row in `chat_messages`, `mutated_task_ids` is the
 * distinct tasks it has changed so far, and `bulk_confirmation_id` is the one confirmation its
 * held writes are collected into, if any. All three are cleared once that confirmation is
 * decided, which is what opens the next turn (spec 07, criterion 14).
 *
 * `mcp_calls` is the audit spec 09's non-goal is amended for: a row per tool call, holding enough
 * to answer "what did that agent see" without holding a second copy of what the content policy
 * just decided how much of to send.
 */
export const mcp: Migration = {
  id: 12,
  name: 'mcp',
  up(database) {
    database.exec(
      "alter table chat_conversations add column source text not null default 'browser' check (source in ('browser', 'mcp'))",
    )
    // Null for a browser conversation, and for an MCP one whose client declared no name: the
    // field the protocol says a request SHOULD carry, and a request that leaves it out is
    // attributed to an unnamed client rather than refused.
    database.exec('alter table chat_conversations add column client_name text')

    database.exec(`
      create table mcp_sessions (
        id text primary key,
        conversation_id text not null references chat_conversations (id) on delete cascade,
        -- What a session is found by: the declared client name, or a fixed sentinel for one that
        -- named none. Not the bare name itself, so that a client legitimately named the same as
        -- the sentinel can never collide with it.
        client_key text not null,
        client_name text,
        last_seen_at integer not null,
        current_turn_message_id text references chat_messages (id) on delete set null,
        mutated_task_ids text not null default '[]',
        bulk_confirmation_id text references chat_confirmations (id) on delete set null,
        -- What each held operation collected into the open bulk confirmation would do, in the
        -- words the confirmation shows: the gate needs these back to extend the summary of the
        -- next held write, and they are not reconstructable from the database as it now stands,
        -- only as it stood at the moment each one was described.
        bulk_descriptions text not null default '[]',
        -- Bumped by every write to the four columns above, and checked by the write that
        -- follows a read: an MCP session's turn spans separate JSON-RPC requests rather than
        -- one function's stack, so two calls against the same session can otherwise read the
        -- same accumulator and each write back believing the other never happened.
        accumulator_version integer not null default 0,
        created_at integer not null
      )
    `)

    // Found by the client's key, most recently seen first, which is the order a session lookup
    // asks for: the newest still-live session for that client, if the idle window allows it.
    database.exec(
      'create index mcp_sessions_lookup on mcp_sessions (client_key, last_seen_at desc)',
    )

    database.exec(`
      create table mcp_calls (
        id text primary key,
        session_id text not null references mcp_sessions (id) on delete cascade,
        tool text not null,
        -- A digest of the arguments rather than the arguments themselves: enough to answer what
        -- was asked for without a second copy of an item's own text sitting beside the content
        -- policy's decision about it.
        arguments_digest text not null,
        held integer not null check (held in (0, 1)),
        content_level text not null,
        policy_version text not null,
        item_count integer not null default 0 check (item_count >= 0),
        created_at integer not null
      )
    `)

    database.exec('create index mcp_calls_session on mcp_calls (session_id, created_at)')
  },
}

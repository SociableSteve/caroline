# 07. Chat

## Purpose

Discuss and modify tasks in natural language: triage a pile of inbox items, reshape a
project, ask what today looks like and why.

## Shape

A persistent conversation, streamed token by token, in a rail beside whichever surface is showing
rather than on a surface of its own: spec 08 owns that, and the reason for it is that asking about the
board while the board is on screen is the whole point. The model is given tools that operate on
Caroline's database and nothing else. Conversations persist across restarts and are listed so an
earlier one can be reopened.

Context supplied on every turn: the shared prompt preamble, which names the system and the person it
is talking to (spec 09), current counts per status, today's plan if one exists, and today's remaining
capacity. Task detail is fetched by the model through tools rather than dumped into the prompt, so the
context stays small and the model works from current data.

## Tools

Read:

- `search_tasks(query?, status?, projectId?, dueBefore?, limit)`
- `get_task(id)` including its source link and classification history
- `list_projects(state?)`
- `get_daily_plan(date?)`
- `get_capacity(date?)`
- `list_waiting(staleOnly?)` for chase conversations: what is outstanding, on whom, how long

Write:

- `create_task({ title, status?, projectId?, notes?, estimateMinutes?, dueAt?, deferUntil?, waitingOn? })`
- `update_task(id, changes)`
- `complete_task(id)`
- `mark_reviewed(id)` for a pull request task, with the same effect as the UI action
- `delete_task(id)`
- `create_project({ title, notes? })`
- `update_project(id, changes)`
- `regenerate_daily_plan(date?)`

There is no tool that reaches an external system. Chat cannot send email, comment on a PR
or create a calendar event, and the tool list is the enforcement.

## Write policy

Every mutation performed by the chat sets `status_set_by = 'user'`, because it happened at
the user's instruction. That means chat decisions are protected from the classifier in
exactly the way manual UI edits are.

`mark_reviewed` is the one exception, and for the same reason the UI action has it: it is a
move inside the GitHub connector's own state machine rather than a decision about where a
task belongs, so it is attributed to `sync` exactly as the board's action is (spec 02). The
user supplied the input; the machine made the move.

- Mutations are applied immediately and rendered inline in the transcript as a compact
  record of what changed, with an undo control.
- Undo is available for the last mutation batch of a turn, implemented as a stored inverse
  operation, not as a general history rewind. The inverse is decided and written at the
  moment of the change, because that is the last moment the previous values exist to be
  read, and it restores the whole prior row rather than a difference. Only the last batch
  that has not been undone can be undone: an older inverse holds values from before whatever
  happened after it, so replaying it would be a silent revert rather than an undo.
- `delete_task` and any operation affecting more than a configurable number of tasks
  (default 10) require explicit confirmation in the UI before they execute. The model
  proposes; the user confirms.

  With one task per write tool, "an operation affecting more than ten tasks" is a turn that
  keeps going, which is exactly the pile-of-inbox-items case above. So the count is the
  turn's: once a turn has changed the threshold number of tasks, every further write in it is
  held rather than applied, collected into one confirmation for the batch that states how
  many tasks the turn would change in total. A held operation is written down with the
  arguments its tool already validated, so confirming performs what was proposed rather than
  something rebuilt from a description of it, and it is recorded against the same turn, so
  undo still covers it.

  A confirmation is decided once. The model is told plainly that nothing happened and that
  the user has been asked, so that it does not report a change it did not make.

  Undoing a deleted task restores its row, its tags, its source links and its place in any daily
  plan that named it. Its classification history is not restored: that cascaded with the delete,
  and an inverse that invented rows would be worse than one that admits the loss.

## Errors and limits

- Tool calls are validated against their schemas before execution. A malformed call returns
  a structured error to the model, which may retry once.
- A turn is capped at a configurable number of tool calls (default 25) to bound cost and
  stop loops.
- If the configured provider or model cannot use tools (spec 03), chat runs read-only and
  says so plainly rather than claiming changes it did not make: no tool is offered at all,
  because a model that cannot call one cannot call a read tool either, the turn is recorded
  as read-only, and the surface says so before anything is typed.
- Token usage per conversation is recorded and shown.

## Non-goals

- Voice, mobile, or a chat surface outside the app.
- Autonomous action between turns. Chat acts only while you are talking to it.
- Access to email or PR content beyond what the storage content policy has already
  retained.
- Multi-turn planning agents or subagents. One model, one tool loop.

## Acceptance criteria

1. Every task or project mutated through chat has `status_set_by = 'user'`, except
   `mark_reviewed`, which is attributed to `sync` exactly as the UI action is (see above).
2. No tool in the registry performs an outbound call to GitHub, Gmail or Calendar.
3. A `delete_task` call is not executed until the user confirms in the UI.
4. A turn that would change more tasks than the configured threshold holds the rest of its
   changes for confirmation, and the confirmation states how many items are affected.
5. Undo after a turn restores the prior values of every task that turn changed.
6. A turn that reaches the tool-call cap ends with a message saying so, leaving prior
   mutations applied and recorded.
7. With a provider that lacks tool support, no write tool is offered and the UI shows chat
   as read-only.
8. Conversations survive a restart and reopen with their full transcript.

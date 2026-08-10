# 01. Task model

## Purpose

Define the GTD entities Caroline stores, how externally sourced items attach to them, and
the guarantees around status changes.

## Statuses

Seven, fixed. They are a property of a task, not a folder.

| Status | Meaning | Typical origin |
| --- | --- | --- |
| `inbox` | Captured, not yet decided | Gmail sync, manual capture, chat |
| `next_action` | A concrete thing you can do now | Classifier, human triage |
| `review` | A pull request awaiting your review | GitHub sync |
| `waiting` | Blocked on someone or something else | Classifier, human triage |
| `someday` | Deliberately not now | Human triage, classifier |
| `reference` | Information to keep, not an action | Classifier, human triage |
| `done` | Completed or no longer relevant | Human, or source resolution |

`project` is deliberately **not** a status. A project is a separate entity that owns
tasks, so that "Projects" in the UI is a view over projects rather than a bucket of tasks
pretending to be one. See below.

## Entities

### `projects`

An outcome that requires more than one action.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | text (uuid) | |
| `title` | text | The outcome, phrased as a result |
| `notes` | text | Markdown, nullable |
| `state` | text | `active` \| `someday` \| `done` \| `dropped` |
| `created_at`, `updated_at`, `completed_at` | integer (epoch ms) | |

A project's **next action** is derived, not stored: the task belonging to it with status
`next_action` and the earliest `sort_order`. A project with no `next_action` task and
`state = 'active'` is *stalled*, which the UI surfaces (spec 08) and the daily planner
flags (spec 05).

### `tasks`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | text (uuid) | |
| `title` | text | |
| `notes` | text | Markdown, nullable |
| `status` | text | One of the seven above |
| `project_id` | text | Nullable FK to `projects.id` |
| `sort_order` | integer | Manual ordering within a status or project |
| `estimate_minutes` | integer | Nullable. Used for capacity fitting |
| `due_at` | integer | Nullable, epoch ms |
| `defer_until` | integer | Nullable. Hidden from Next actions until this passes |
| `waiting_on` | text | Nullable free text, only meaningful when `status = 'waiting'` |
| `status_set_by` | text | `user` \| `llm` \| `sync` |
| `status_set_at` | integer | epoch ms |
| `sync_tracked` | integer (bool) | Whether sync still owns this task's lifecycle. See below |
| `created_at`, `updated_at`, `completed_at` | integer | |

`tags` are a join table (`task_tags`), not a delimited string.

### `sources`

One row per externally ingested item. A source may exist without a task (a calendar event
never becomes a task) and a task may exist without a source (manual capture).

| Column | Type | Notes |
| --- | --- | --- |
| `id` | text (uuid) | |
| `provider` | text | `github` \| `gmail` \| `gcal` |
| `external_id` | text | Provider-stable identifier |
| `url` | text | Deep link back to the item |
| `title` | text | |
| `metadata` | text (json) | Provider-specific, shape owned by the connector |
| `content` | text | Nullable. Governed by the storage content policy (spec 09) |
| `content_hash` | text | Detects upstream change without diffing bodies |
| `task_id` | text | Nullable FK |
| `first_seen_at`, `last_seen_at` | integer | |
| `resolved_at` | integer | Nullable. Set when the upstream item closes |
| `suppressed_at` | integer | Nullable. Set when the item is a second telling of one another connector already covers. See spec 02 |
| `lifecycle_state` | text | Nullable. Connector-owned state machine position. See spec 02 |
| `acted_at` | integer | Nullable. When the user last discharged their part (for a PR, reviewed it) |
| `acted_at_marker` | text | Nullable. Upstream position at `acted_at`, so later change is detectable |

Unique index on `(provider, external_id)`. This is the dedupe key for the whole sync
engine.

Supporting tables (`calendar_events`, `classifications`, `daily_plans`, `job_runs`,
`chat_messages`) are defined in the specs that own them.

## Behaviour

### Status transitions

Any status can move to any other. There is no workflow graph to enforce, because GTD
triage is genuinely free-form. Two rules constrain it:

1. Setting a status records `status_set_by` and `status_set_at`.
2. Once `status_set_by = 'user'`, the classifier never touches the task again (spec 04).
   Sync is constrained differently, by tracking.

### Sync tracking

Some source-backed items have a genuine lifecycle: a pull request moves between needing
your review, waiting on its author, and finished, and it can move backwards. Those
transitions are facts about the world, not opinions, so sync must be able to apply them even
after you have set a status by hand.

A task created by sync starts with `sync_tracked = true`. While tracked, its connector owns
transitions within a declared set of statuses, stated in the connector's spec. For the
GitHub connector that set is `review`, `waiting` and `done`.

Tracking stops, permanently, when the user moves the task to a status outside that set.
Filing a review request under `someday` or `reference` is a decision to opt out of the
lifecycle, and sync respects it: `sync_tracked` becomes false and no further sync changes
the task. It can be re-enabled explicitly from the UI.

Within the tracked set, a user action does not stop tracking, it becomes an input to the
state machine. Marking a PR reviewed sets `acted_at` and `acted_at_marker` on the source, so
that sync can distinguish "nothing has happened since you acted" from "the author has since
responded". Only upstream change newer than the marker moves the task back.

The classifier is unaffected either way: it only ever considers `inbox` tasks, and tracked
tasks never enter the inbox.

### Completion

Completing a task sets `status = 'done'` and `completed_at`. Completing a project does not
complete its tasks; it is flagged in the UI if open tasks remain.

### Deletion

Tasks are hard-deleted only by explicit user action. Sync never deletes a piece of work: a
source whose upstream item disappears is marked `resolved_at`, and its task, if any, is
proposed for completion rather than removed.

There is one exception, and it is not work being thrown away. An untriaged inbox task that
turns out to be a duplicate of something already on the board is retired: deleted, with its
source relinked to the task that owns the work, so the card goes and the provenance stays. It
applies only while the task is untriaged, which is `status = 'inbox'` and
`status_set_by != 'user'`; a task the user has decided on is theirs, and the rule steps aside.
Spec 02 defines the one case that reaches it, a GitHub notification email about a pull request
Caroline already has.

## Non-goals

- Recurring tasks. A recurring commitment is a calendar event.
- Dependencies between tasks beyond `waiting_on` free text.
- Contexts (`@home`, `@calls`). Tags cover this if it turns out to be wanted.
- Subtasks. A task that needs subtasks is a project.

## Acceptance criteria

1. Creating a task with no status defaults it to `inbox` with `status_set_by = 'user'`.
2. A task whose `status_set_by` is `user` is unchanged by a classifier run that proposes a
   different status, and the proposal is still recorded in `classifications`.
2a. A tracked task moved by the user to a status inside its connector's tracked set stays
   tracked; moved to a status outside it, `sync_tracked` becomes false and no later sync
   changes it.
3. Inserting two sources with the same `(provider, external_id)` updates the existing row
   rather than creating a second.
4. A project with one `next_action` task reports that task as its next action; with none
   and `state = 'active'` it reports as stalled.
5. Tasks with `defer_until` in the future are excluded from the Next actions view and from
   daily planning, and reappear once it passes.
6. Deleting a project sets `project_id` to null on its tasks rather than deleting them.
7. Every schema change ships as a numbered migration that runs on startup and is
   idempotent.

# 01. Task model

## Purpose

Define the GTD entities Caroline stores, how externally sourced items attach to them, and
the guarantees around status changes.

## Statuses

Eight, fixed. They are a property of a task, not a folder.

| Status | Meaning | Typical origin |
| --- | --- | --- |
| `inbox` | Captured, not yet decided | Gmail sync, manual capture, chat |
| `next_action` | A concrete thing you can do now | Classifier, human triage |
| `review` | A pull request awaiting your review | GitHub sync |
| `waiting` | The next move belongs to somebody else, who is named in `waiting_on` | Classifier, human triage |
| `blocked` | Another task of yours has to finish first, and `blocked_by` names it | Human triage |
| `someday` | Deliberately not now | Human triage, classifier |
| `reference` | Information to keep, not an action | Classifier, human triage |
| `done` | Completed or no longer relevant | Human, or source resolution |

`waiting` is a person and `blocked` is a task of your own. That is the whole of the difference,
and it is why `waiting`'s meaning above names somebody else rather than "someone or something
else": the looser wording is what made the two states look like one.

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
| `status` | text | One of the eight above |
| `project_id` | text | Nullable FK to `projects.id` |
| `sort_order` | integer | Manual ordering within a status or project |
| `estimate_minutes` | integer | Nullable. Used for capacity fitting |
| `due_at` | integer | Nullable, epoch ms |
| `defer_until` | integer | Nullable. Hidden from Next actions until this passes |
| `waiting_on` | text | Nullable free text, only meaningful when `status = 'waiting'` |
| `blocked_by` | text | Nullable FK to `tasks.id`: the task that has to finish first. Not null exactly when `status = 'blocked'`. See below |
| `status_set_by` | text | `user` \| `llm` \| `sync` |
| `status_set_at` | integer | epoch ms |
| `previous_status` | text | Nullable. What `status` was before the most recent change, so that change can be put back. See below |
| `previous_status_set_by` | text | Nullable. What `status_set_by` was at the same moment |
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
| `suppressed_at` | integer | Nullable. Set when the item is a second telling of an item another connector already covers. See spec 02 |
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
3. Setting a status also records what the status and its actor were immediately before, in
   `previous_status` and `previous_status_set_by`, so that the change can be put back.

Rule 3 exists because of rule 2. A status change is cheap to make and, when the actor is the
user, permanent in its effect: it takes the task out of the classifier's reach for good. On the
board a change is a single keypress (spec 08), so the cost of a mistake and the cost of making
one are badly matched. Putting a status back therefore has to restore the actor as well as the
status, and that means knowing what the actor was.

One step, not a history. Each change overwrites the previous pair, so what is recoverable is the
last change and nothing before it. A task never changed since creation has both columns null and
nothing to put back. Undo is not itself a status change for the purpose of this rule: putting a
change back does not record the state it is undoing as the new previous one, because that would
make undo a toggle and lose the thing being restored.

### Blocking

A task may name one task of yours that has to finish before it can start. The status and the
reference are one fact, not two: **a task has status `blocked` if and only if `blocked_by` names
a task.** That is a table check constraint, `(status = 'blocked') = (blocked_by is not null)`, so
the database refuses the disagreement rather than the application remembering to avoid it.
Anything that sets one without the other fails at write time, in the suite as much as in
production.

Naming a blocker is therefore a status change like any other, and goes through the same rule as
the rest: it records the actor, the moment, and the pair that came before. Clearing the blocker
moves the task to `next_action`, which is what an unblocked concrete action is. Sync tracking is
the one thing neither move touches, for the reason given under Sync tracking above.

**Completing a blocker releases what was behind it.** The dependents lose their reference and move
to `next_action`, attributed to `user`, because the act that caused it is the user completing the
blocker and there is no other actor in the story. A fourth value of `status_set_by` would ripple
through every place that switches on the actor for no behavioural gain, and `user` keeps the
existing protection working in the dependent's favour, since the classifier may not overrule a
status the user set.

**Deleting a blocker releases them too, in the same transaction as the delete.** `on delete set
null` is the right clause on the column and is not sufficient on its own: it would null the
reference and leave the status saying `blocked`, which the invariant forbids. The move is made in
the application rather than by a database trigger, because the rules live in the domain and a
trigger would hide a status change from the layer that owns status changes.

**Unblocking is one way.** Reopening a completed blocker does not re-block its dependents, because
the reference went when it completed. Getting the dependency back means naming it again, which is
honest: the second block is a new decision rather than the resumption of an old one. For the same
reason, putting back a status change that moved a task out of `blocked` is refused: the blocker
went with the move, and the status cannot stand without one. The other direction is not refused
but it is not a resumption either: putting back a change that moved a task *into* `blocked` clears
the reference along with the status, exactly as any other move out of the column does, so the undo
leaves a whole fact rather than half of one.

**A task that is already finished cannot be named as a blocker.** The release happens on the
transition to `done`, so nothing would ever release a task filed behind work that finished last
week: it would sit in the Blocked column until somebody noticed, which is the burial this state
exists to prevent. The attempt is refused with its reason, in the same read that refuses a blocker
that does not exist and one that would come back round, so every write path answers it the same
way and the picker on the board has nothing to offer that the write would take and then strand.

**One blocker, not several, and no cycles.** The question a blocked card exists to answer is why
this cannot be started, and one task is an answer where a set is a research task. Work with more
than one thing that has to finish first already has a name here, and it is a project. A task may
not be blocked behind itself, directly or through a chain of blockers; the walk that refuses it is
a pure function in the domain beside the status rules, returning a refusal rather than throwing,
so every write path gets the same answer and none of them has to remember to ask a different one.
It is not a database trigger, because SQLite cannot express a recursive check and a trigger is
invisible to the type system.

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

Blocking is the exception, because it is not that kind of decision. A tracked task moved to
`blocked` stays tracked, and stays tracked when the blocker clears and it returns to
`next_action`. Naming a blocker says this cannot start yet, not that the connector's lifecycle
is unwanted, and it takes nothing away from the connector while it lasts: a connector owns
transitions only for a task currently inside its own set, so a blocked task is out of reach
whether it is tracked or not. Spending a permanent opt-out on a temporary state would detach a
pull request from GitHub for good, and the act that did it would be picking a name out of a
dropdown on a card. That holds however either move is spelled, naming the blocker alone or naming
the status and the blocker together, because they are the same act. Criterion 21.

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
source relinked to the task that owns the work where there is one, so the card goes and the
provenance stays. Where there is not, the source keeps `task_id` null and stays that way;
retiring a duplicate never creates a task to hold the link.

It applies only while the task is untriaged, which is `status = 'inbox'` and
`status_set_by != 'user'`; a task the user has decided on is theirs, and the rule steps aside.
Spec 02 defines the one case that reaches it, a GitHub notification email about a pull request
Caroline already has.

## Non-goals

- Recurring tasks. A recurring commitment is a calendar event.
- Dependencies between tasks beyond `waiting_on` free text and a single blocking task. A task
  may name one task of yours that has to finish before it can start. Several blockers,
  dependencies between projects, a dependency graph to traverse or display, and any ordering or
  scheduling derived from dependencies, are out of scope.
- Contexts (`@home`, `@calls`). Tags cover this if it turns out to be wanted.
- Subtasks. A task that needs subtasks is a project.

## Acceptance criteria

1. Creating a task with no status defaults it to `inbox` with `status_set_by = 'user'`.
2. A task whose `status_set_by` is `user` is unchanged by a classifier run that proposes a
   different status, and the proposal is still recorded in `classifications`.
2a. A tracked task moved by the user to a status inside its connector's tracked set stays
   tracked; moved to a status outside it, `sync_tracked` becomes false and no later sync
   changes it. `blocked` is the one status outside the set that does not opt out, and
   criterion 21 states why.
3. Inserting two sources with the same `(provider, external_id)` updates the existing row
   rather than creating a second.
4. A project with one `next_action` task reports that task as its next action; with none
   and `state = 'active'` it reports as stalled.
5. Tasks with `defer_until` in the future are excluded from the Next actions view and from
   daily planning, and reappear once it passes.
6. Deleting a project sets `project_id` to null on its tasks rather than deleting them.
7. Every schema change ships as a numbered migration that runs on startup and is
   idempotent.
8. A status change records the prior status and prior actor in `previous_status` and
   `previous_status_set_by`, and a second change overwrites them rather than accumulating.
9. Putting a status change back restores both the status and the actor, so a task the
   classifier had set, moved by the user and then put back, is once again a task the classifier
   may act on.
10. Putting a change back does not record the undone state as the new previous one, so undo
    cannot be applied twice to walk further back.
11. A task never changed since creation has both previous columns null, and there is nothing to
    put back.

Issue #91 added blocking, and the following with it, appended rather than renumbered because the
code and the suite cite these by number.

12. `blocked` and `blocked_by` are one fact: the schema refuses a task with status `blocked` and no
    blocker, and refuses a task carrying a blocker under any other status.
13. Naming a blocker moves the task to `blocked`, attributed to the user; clearing the blocker
    moves it to `next_action` and leaves no reference behind.
14. Completing a task clears the reference on every task blocked behind it and moves each of them
    to `next_action`, attributed to `user`.
15. Deleting a task moves the tasks blocked behind it to `next_action` with no blocker, in the same
    transaction as the delete, so no row is left claiming to be blocked behind a task that has gone.
16. Reopening a completed blocker re-blocks nothing. Unblocking is one way, and the dependency has
    to be named again. This holds however the blocker is reopened, chat's own undo of the turn that
    completed it included: that undo restores the blocker, not the tasks the completion released.
17. A task cannot be blocked behind itself, directly or through a chain of blockers. The attempt is
    refused with its reason rather than written.
18. Putting back a status change that moved a task out of `blocked` is refused, because the blocker
    went with the move and the status cannot stand without one.
19. A task that is already `done` cannot be named as a blocker. The attempt is refused with its
    reason rather than written, because completing it is what releases a dependent and that moment
    has passed.
20. Putting back a status change that moved a task into `blocked` clears the blocker along with the
    status, so the undo can never leave a task holding a reference under another status.
21. Blocking is transparent to sync tracking. A tracked task moved to `blocked` is still tracked,
    and is still tracked once the blocker is cleared and it returns to `next_action`, whether
    either move names the blocker alone or names the status and the blocker together. Criterion
    2a's opt-out is a decision to file the task away from its connector's lifecycle, and this is
    not one.

# 02. Ingestion

## Purpose

Pull items from GitHub, Gmail and Google Calendar into `sources` and, where appropriate,
into `tasks`. Do it repeatedly without creating duplicates and without losing user edits.

## Sync engine

Connectors implement one interface:

```ts
interface Connector {
  readonly provider: 'github' | 'gmail' | 'gcal'
  isConfigured(): boolean
  fetch(since: number | null): AsyncIterable<SourceItem>
}

interface SourceItem {
  externalId: string
  url: string
  title: string
  metadata: Record<string, unknown>
  content?: string          // subject to the storage content policy
  resolved?: boolean        // upstream item is closed/merged/handled
  occurredAt: number
}
```

The engine owns everything else: upsert by `(provider, external_id)`, content hashing,
task creation, error handling and run recording.

### Upsert rules

- New `(provider, external_id)`: insert the source, and create a task if the connector's
  policy says items of this kind become tasks.
- Existing row, `content_hash` unchanged: touch `last_seen_at` only. No task change, no
  reclassification.
- Existing row, `content_hash` changed: update the source, and if its task is still in
  `inbox` return it to the classification queue. A task the user has already triaged is
  left alone; the change is visible in the UI instead.
- `resolved: true`: set `resolved_at`, and propose completion of the linked task.

Proposing completion means recording the proposal on the source, and applying it only where
sync still owns the answer: a task whose status the user set themselves is left where they
put it, with the proposal shown on the card for them to accept or ignore. A task sync has
been opted out of is not touched at all.

A connector applies a transition to an existing task only inside the set of statuses it
declares, and only while the task is already in that set. A connector that declares no set,
as Gmail does, owns no transitions: it captures an item once, and where it goes after that
is the user's decision rather than something reasserted every fifteen minutes.

### Failure handling

A connector failure fails that connector's run only. Others continue. Failures are
recorded in `job_runs` (spec 06) with the error, surfaced in the UI, and retried on the
next scheduled run with exponential backoff on repeated failure. Rate limiting is handled
by respecting the provider's own headers, not by fixed sleeps.

Sync is incremental where the provider supports it (`since` cursor persisted per
connector) and full-scan where it does not, bounded by a configurable lookback window.

## GitHub connector

**Scope: pull requests where you are a requested reviewer, followed until they close.**
Directly requested, and requested via a team you belong to.

- Auth: a fine-grained personal access token, read-only, `pull_requests: read` plus
  `metadata: read` on the relevant orgs.
- Items become tasks with `status_set_by = 'sync'`. They never enter the inbox: a review
  request is unambiguous and needs no classification.
- `estimate_minutes` is seeded from PR size (changed files and lines) using a fixed,
  documented heuristic, and is editable:

  ```text
  minutes = 10 + 2 per changed file + 1 per 20 changed lines
  ```

  rounded to the nearest five minutes and clamped between ten minutes and four hours. The
  three terms are the three costs: opening it and reading what it is for, moving between
  files, and reading the lines. Files weigh more than lines because a diff spread over twenty
  files is a harder read than the same number of lines in one, and the clamp is what a
  generated lockfile hits. It is a starting point, deliberately crude, and it is seeded once:
  a later sync never overwrites an estimate.
- Metadata retained: repo, number, author, draft flag, additions, deletions, changed
  files, requested-at, head sha, your latest review state and its timestamp.

### Two passes

A review request disappears from GitHub's search results the moment you submit a review, so
a discovery query alone cannot follow a PR through its life. The connector runs two passes:

1. **Discovery.** Search for open PRs with a review request for the authenticated user or
   a team they belong to. Finds new work.
2. **Refresh.** Fetch every non-resolved `github` source directly by id, regardless of
   whether the discovery query still returns it. Follows work already known.

The refresh pass is what makes the lifecycle below possible. It is batched (GraphQL, or
conditional REST requests using stored ETags) so that following a few dozen open PRs costs
little against the rate limit.

### Review lifecycle

`sources.lifecycle_state` holds the position. Tracked statuses are `review`, `waiting` and
`done` (spec 01).

| State | Task status | Entered when |
| --- | --- | --- |
| `awaiting_review` | `review` | You are a requested reviewer |
| `reviewed` | `waiting` | You have discharged your part; the next move is the author's |
| `closed` | `done` proposed | The PR merged or closed |

Transitions:

- **New review request** to `awaiting_review`. Task created or moved to `review`.
- **You submit a review on GitHub** (any state: approved, changes requested, commented) to
  `reviewed`. Task moves to `waiting`, with `waiting_on` set to the PR author.
  `acted_at` is the review submission time and `acted_at_marker` is the head sha at that
  point.
- **You mark it reviewed in Caroline** to `reviewed`, identically, with `acted_at` set to
  now and the marker set to the current head sha. This covers reviewing away from a
  keyboard, approving in a call, or deciding it does not need your eyes.
- **Back to `awaiting_review`** when either of these is true and newer than `acted_at`:
  - your review is re-requested, or
  - new commits have landed since `acted_at_marker` **and** your last review state was
    `CHANGES_REQUESTED`.

  The second condition is configurable as `github.returnToReviewOnNewCommits`, default
  true. Set it false to return only on an explicit re-request.
- **To `closed`** when the PR merges or closes, from any state. Sets `resolved_at` and
  proposes completion.
- **Dropped as a reviewer** without having reviewed: `resolved_at` is set and completion is
  proposed. This is the one case where leaving the discovery results really does mean the
  work is gone.

The `acted_at` marker is what stops a marked-reviewed PR bouncing straight back to `review`
on the next sync fifteen minutes later. Only upstream activity later than the marker counts.

### Visibility guarantee

The point of `waiting` here is not bookkeeping, it is chasing. An open PR you have reviewed
is unfinished work that has left GitHub's review-requested view, which is exactly how these
get lost. So:

**An open PR is never invisible.** From the moment it is ingested until it merges or closes,
it appears in one of your views: `review` while it needs you, `waiting` while it needs the
author. Nothing in sync may complete, hide or drop an open PR. Completion is proposed only
on close, or on being dropped as a reviewer.

`waiting` items carry the age since `acted_at`, are ordered oldest first, and cross a
staleness threshold, `tasks.waitingStaleDays`, after which they are called out: in the
Waiting column (spec 08), on the dashboard, and as chase nudges in the daily plan (spec 05).
It defaults to 7 days. Chasing is itself work, and it is the thing this status exists to
prompt.

An item with no source has no `acted_at`, so for a manually created `waiting` task the age is
measured from `status_set_at`: the moment it became somebody else's turn.

## Gmail connector

**Scope: one account, read-only, thread level.**

- Auth: Google OAuth desktop flow, scope `gmail.readonly` only.
- Query: configurable Gmail search string, defaulting to `in:inbox -category:promotions
  -category:social`. Thread level, not message level: one task per thread.
- Items become tasks with `status = 'inbox'` and `status_set_by = 'sync'`, awaiting
  classification (spec 04).
- What is stored, and what is later sent to an LLM, is governed by the content policies in
  spec 09. The connector always retrieves enough to compute the configured policy and
  never persists more than the storage policy allows.
- Resolution: the thread leaves the query result set (archived or otherwise handled in
  Gmail directly). Proposes completion so that triaging in Gmail is not lost work.
- Metadata retained: thread id, participants, subject, message count, last message time,
  Gmail labels.

## Calendar connector

**Scope: one account, read-only, capacity input.**

- Auth: Google OAuth desktop flow, scope `calendar.readonly`.
- Fetches events in a rolling window, default from 1 day back to 14 days forward, from the
  primary calendar plus any additional calendar ids configured.
- Events are stored in `calendar_events` and **never become tasks**. They exist to compute
  free capacity (spec 05) and to render the dashboard (spec 08).
- Declined events and events marked as free/transparent do not consume capacity.
  All-day events do not consume capacity unless configured to.
- Metadata retained: id, summary, start, end, all-day flag, response status, transparency,
  attendee count, calendar id.

## Non-goals

- Any write operation: no labels, no archiving, no PR comments, no calendar entries.
- Multiple accounts per provider.
- GitHub issues, assigned PRs, mentions or notifications. Review requests only.
- Attachment or document contents.
- Real-time push (webhooks, Gmail watch). Polling on a schedule is sufficient at this
  scale and avoids exposing an inbound endpoint.

## Acceptance criteria

1. Running a sync twice over an unchanged fixture produces one source row and one task per
   item, with `last_seen_at` advanced on the second run.
2. A source whose upstream content changes updates `content_hash`, and requeues its task
   for classification only when that task is still in `inbox`.
3. A user-triaged task is not moved back to `inbox` by any subsequent sync.
4. A merged PR marks its source resolved and proposes completion of its task, and does not
   silently complete a task the user has edited since.
5. A connector that throws does not prevent the other connectors from completing, and its
   failure appears in the run history with the error message.
6. With no credentials configured, each connector reports `isConfigured() === false` and
   the engine skips it without error.
7. Calendar events never create tasks, in any code path.
8. Every connector is testable against recorded fixtures with no network access.
9. Submitting a review on GitHub moves the task from `review` to `waiting` with
   `waiting_on` set to the PR author, and does not complete it.
10. Marking a PR reviewed in Caroline moves it to `waiting` and sets `acted_at` and the head
    sha marker.
11. A PR marked reviewed with no subsequent upstream activity stays in `waiting` across any
    number of sync runs.
12. A re-requested review after `acted_at` moves the task back to `review`.
13. New commits after `acted_at_marker` move the task back to `review` when the last review
    state was `CHANGES_REQUESTED`, and do not when it was `APPROVED`.
14. With `returnToReviewOnNewCommits: false`, only an explicit re-request returns a task to
    `review`.
15. An open PR is present in either the `review` or `waiting` view at every point in its
    life, asserted by driving a fixture through the full transition sequence.
16. Merging or closing a PR proposes completion from either `review` or `waiting`.
17. A user moving a tracked PR task to `someday` stops tracking, and a later re-request does
    not move it back.
18. The refresh pass fetches PRs that the discovery query no longer returns.

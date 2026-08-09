# 08. API and UI

## HTTP API

Fastify, JSON, everything under `/api`. Schemas are declared for every route and used for
both validation and typing. Errors follow one shape: `{ error: { code, message, details? } }`.

| Route | Purpose |
| --- | --- |
| `GET /api/tasks` | Filter by status, project, tag, due, search; paginated |
| `POST /api/tasks` | Create |
| `PATCH /api/tasks/:id` | Update, including status changes |
| `DELETE /api/tasks/:id` | Delete |
| `POST /api/tasks/:id/complete` | Complete |
| `POST /api/tasks/:id/mark-reviewed` | Discharge your part of a review: moves it to Waiting for and stamps the marker (spec 02) |
| `POST /api/tasks/:id/tracking` | Re-enable sync tracking on a task that opted out |
| `POST /api/tasks/bulk` | Bulk status change or project assignment |
| `GET|POST /api/projects`, `PATCH|DELETE /api/projects/:id` | Projects, with derived next action and stalled flag |
| `GET /api/plan/:date` | A daily plan, defaulting to today |
| `POST /api/plan/:date/regenerate` | Regenerate |
| `GET /api/calendar` | Events in a range, plus computed capacity |
| `GET /api/inbox/proposals` | Low-confidence classifications awaiting a decision |
| `POST /api/inbox/proposals/:id/accept|dismiss` | Resolve one |
| `POST /api/chat` | Streamed turn (SSE) |
| `GET /api/chat/conversations`, `GET /api/chat/conversations/:id` | History |
| `GET /api/jobs`, `POST /api/jobs/:name/run` | Run history, manual trigger |
| `GET /api/config`, `PATCH /api/config` | Read and update runtime config, secrets redacted |
| `GET /api/health` | Process, database, per-integration configured and last-run status |

Server-sent events are used for chat streaming and for a lightweight change feed the UI
subscribes to, so a background job's results appear without a refresh.

## UI

Five surfaces.

**Dashboard.** Today's plan, today's calendar in a column with the busy and free blocks
visible, a capacity bar showing planned against available, counts per status, waiting items
that have gone quiet, stalled projects, and the last-run state of each job. The quiet-waiting
panel is a chase list, not a count: it names the item, who it is on, and for how long.

**Board.** One column per status: Inbox, Next actions, Review, Waiting for, Someday,
Reference. Drag between columns to set status, which marks the change as user-set. Inbox
items carrying a low-confidence proposal show it inline with accept and dismiss.

Review cards have a **Mark reviewed** action, on the card and on a keyboard shortcut, which
moves the PR to Waiting for. It is the primary action on the card, because it is the one
taken most often.

The Waiting for column is a chase list. Every card shows how long it has been waiting and on
whom, ordered oldest first, with items past the staleness threshold visibly flagged. PR
cards show whether the author has pushed anything since you reviewed. A task that has opted
out of sync tracking (spec 01) is marked as such, so it is clear why it stopped moving on
its own.

**Projects.** List of projects with their derived next action, stalled ones marked. Drill
into a project for its tasks.

**Chat.** Transcript, streamed responses, inline records of what changed with undo, and
confirmation prompts for deletes and bulk operations.

**Settings.** Integration status and connect flows, schedules, LLM provider and model,
content policies (spec 09) with their consequences spelled out in plain language, working
hours and reserve, classification threshold.

### Interaction rules

- Keyboard first on the board: move between items, change status, complete, capture.
- Quick capture is reachable from anywhere and creates an inbox task.
- Every task shows its provenance: which source it came from, with a link out, and why the
  classifier put it where it did.
- Nothing is hidden behind a hover. Status, estimate and due date are visible on the card.

### Accessibility and appearance

Keyboard operable throughout, visible focus, semantic landmarks, and contrast meeting WCAG
AA in both light and dark. Colour never the only carrier of meaning: statuses and states
also carry text or shape.

## Non-goals

- Multi-user affordances: no sharing, assignment, comments or presence.
- Offline-first or local caching beyond what the browser does by default.
- A public API for third parties. The API exists to serve this UI.
- Theming or customisable layouts.

## Acceptance criteria

1. Every route declares a schema, and a request violating it returns 400 in the standard
   error shape.
2. `GET /api/config` never returns an API key, token or refresh token, in any field.
3. Moving a task between board columns results in `status_set_by = 'user'`.
4. The dashboard renders correctly with no plan, no calendar and no integrations
   configured, showing empty states rather than errors.
5. A background job completing updates the open UI without a manual refresh.
6. The capacity bar's numbers match `GET /api/calendar` for the same date.
7. Chat streams incrementally and a dropped connection leaves the conversation recoverable
   on reload.
8. The board is fully operable by keyboard alone, including status changes and marking a
   review done.
9. Mark reviewed moves the card to Waiting for and it remains visible there, with its age
   and the author named.
10. A waiting item past the staleness threshold is visually distinguished in the column and
    listed on the dashboard.

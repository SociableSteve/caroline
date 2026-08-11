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
| `POST /api/tasks/:id/undo-status` | Put the last status change back, restoring `status_set_by` with it. 409 where there is nothing to undo |
| `POST /api/tasks/bulk` | Bulk status change or project assignment |
| `GET|POST /api/projects`, `PATCH|DELETE /api/projects/:id` | Projects, with derived next action and stalled flag |
| `GET /api/plan` | Today's daily plan, with the fortnight of planned against completed beside it |
| `GET /api/plan/:date` | The same, for a named date |
| `POST /api/plan/:date/regenerate` | Redraw today's plan, keeping the day's earlier versions as history. Today only, because an earlier day's plan is a record of what was proposed on it (spec 05) |
| `GET /api/calendar` | A day's events, defaulting to today, plus its computed capacity |
| `GET /api/inbox/proposals` | Low-confidence classifications awaiting a decision |
| `POST /api/inbox/proposals/:id/accept|dismiss` | Resolve one |
| `POST /api/chat` | Streamed turn (SSE) |
| `GET /api/chat/status` | Whether chat is configured, and whether it can change anything |
| `GET /api/chat/conversations`, `GET /api/chat/conversations/:id` | History |
| `POST /api/chat/confirmations/:id` | Confirm or discard an operation the model proposed (spec 07) |
| `POST /api/chat/conversations/:id/undo` | Undo the last turn's changes (spec 07) |
| `GET /api/jobs`, `POST /api/jobs/:name/run` | Run history, manual trigger |
| `GET /api/config`, `PATCH /api/config` | Read and update runtime config, secrets redacted |
| `GET /api/health` | Process, database, per-integration configured and last-run status |

Server-sent events are used for chat streaming and for a lightweight change feed the UI
subscribes to, so a background job's results appear without a refresh.

## UI

Six surfaces.

**Dashboard.** The morning question is "what am I doing today, and does it fit". The dashboard
answers that first and everything else after, in three bands, in this order. The bands are fixed
rows rather than one reflowing grid, because a reading path that changes with the window width is
not a reading path.

1. **Today.** The plan, with the capacity bar and today's calendar column beside it. Leads, at
   the full width of the surface, because it is the answer to the question the surface exists to
   answer. The calendar shows the busy and free blocks; the capacity bar shows planned against
   available.
2. **Wants a decision.** Waiting items that have gone quiet, worth-a-chase nudges, the plan's
   overflow, and stalled projects. Second, because each of these is something only the user can
   resolve. The quiet-waiting panel is a chase list, not a count: it names the item, who it is
   on, and for how long.
3. **State of the machine.** Counts per status, the last-run state of each job, and per
   integration whether it is configured. Last, and condensed into a single strip rather than a
   panel each: this band is scanned to confirm nothing is broken, and read no further when
   nothing is. A count is not work, and it should not lead a surface about work.

Nothing in band 3 may be given the same visual weight as band 1. This is the criterion the
previous version of this spec was missing, and its absence is why counts led the surface for
three milestones.

**Board.** One column per status: Inbox, Next actions, Review, Waiting for, Someday,
Reference. Drag between columns to set status, which marks the change as user-set. Inbox
items carrying a low-confidence proposal show it inline with accept and dismiss.

Six columns are six columns. Where six do not fit at the width available, the board scrolls
sideways within its own region; it never wraps some of them onto a second row. A wrapped column
is below and to the left of a column it is logically to the right of, which puts the layout in
direct contradiction with the arrow keys, and the keyboard is the point of this surface.

Each column scrolls on its own within a bounded height. Without that the page grows to the length
of the longest column, two columns of very different lengths cannot be compared, and the status a
card should move to may be off the bottom of the screen when the card is in view. Below the
breakpoint where six columns stop being usable, the columns stack and each is read whole.

A card's actions are not its facts. Every fact stays visible, per the interaction rules below; the
controls do not all have to be. The primary action is on the card, and the rest go behind a
disclosure on the card, keyboard reachable, that does not capture the arrow keys the board's grid
needs. Three controls abreast do not fit a column, and a card whose controls are taller than its
content has the emphasis backwards.

A card does not restate its own status. The column it is in says it, and so does the status
control; a third telling in the fact list is noise, and on the Inbox, Someday and Reference cards
it is the fact list's only row.

Review cards have a **Mark reviewed** action, on the card and on a keyboard shortcut, which
moves the PR to Waiting for. It is the primary action on the card, because it is the one
taken most often.

The Waiting for column is a chase list. Every card shows how long it has been waiting and on
whom, ordered oldest first, with items past the staleness threshold visibly flagged. PR
cards show whether the author has pushed anything since you reviewed. A task that has opted
out of sync tracking (spec 01) is marked as such, so it is clear why it stopped moving on
its own.

The last status change made on the board can be undone. A board move is one keystroke, and by
design it records `status_set_by = 'user'`, which locks the classifier out of that task from then
on (spec 01). So a mistyped digit does not merely put a card in the wrong column: it silently
takes that task out of the classifier's reach for good. Chat, where every change is deliberate and
described before it happens, has an undo for exactly this reason; the board, where a change is a
single keypress, needs one more.

Undoing restores both the previous status and the previous `status_set_by`, because restoring the
status alone would leave the classifier locked out and the undo would not have undone the part
that mattered. That requires the previous pair to be recorded, which spec 01 now defines, and its
own route: `PATCH` cannot express it, since the API is the user and a user cannot claim to be the
classifier. Only the most recent change is undoable, and only until another change replaces it.
This is not a history feature.

**Projects.** List of projects with their derived next action, stalled ones marked. Drill
into a project for its tasks.

**Chat.** Transcript, streamed responses, inline records of what changed with undo, and
confirmation prompts for deletes and bulk operations. Earlier conversations are listed beside
it, with what each one has cost. Read-only is stated before anything is typed, and so is a
turn that stopped at its tool-call limit.

**Jobs.** What each background job is for, when it last ran and how that went, when it runs
next, whether a run of failures is holding it back, and a button to run it now. Spec 06 owns
the behaviour; this is where it is discoverable, because a scheduler that says nothing needs a
surface that does.

**Settings.** Integration status and connect flows, schedules, LLM provider and model,
content policies (spec 09) with their consequences spelled out in plain language, working
hours and reserve, classification threshold.

### Interaction rules

- Keyboard first on the board: move between items, change status, complete, capture.
- Quick capture is reachable from anywhere and creates an inbox task.
- Every task shows its provenance: which source it came from, with a link out, and why the
  classifier put it where it did.
- Nothing is hidden behind a hover. Status, estimate and due date are visible on the card.
  This is a rule about information, not about controls: a fact is never a hover or a click
  away, while a secondary control may be behind a disclosure that is visible and labelled.
- A destructive or irreversible action is either confirmed in place or undoable. Delete
  confirms on the card; a status change undoes.

### Accessibility and appearance

Keyboard operable throughout, visible focus, semantic landmarks, and contrast meeting WCAG
AA in both light and dark. Colour never the only carrier of meaning: statuses and states
also carry text or shape.

Regions keep the semantics they have. A `section` with an accessible name is already navigable;
wrapping a set of them in list roles replaces that with list semantics and costs the headings
their place in the outline, which is a poor trade on the surfaces that most need an outline.

Spec 10 owns the scales, the primitives and the appearance rules the surfaces draw from. What is
here is the behaviour each surface owes the reader; what is there is what all six have in common.

## Non-goals

- Multi-user affordances: no sharing, assignment, comments or presence.
- Offline-first or local caching beyond what the browser does by default.
- A public API for third parties. The API exists to serve this UI.
- Theming or customisable layouts. The design tokens of spec 10 are not theming: they exist so
  that Caroline is consistent with itself, and there is nothing for a user to choose.
- An undo for anything but the last status change. Chat has its own, per turn (spec 07), and
  neither is a general history.

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

Criteria 1 to 10 are unchanged and are referenced by name throughout the code and the suite.
The design pass adds the following, appended rather than renumbered for that reason.

11. The dashboard's bands render in the order given above at every width, and no panel of band 3
    is laid out at the size of a band 1 panel.
12. The board renders all six columns on one row, or scrolls sideways with all six still on one
    row, or stacks them; it never renders some columns on a second row while others share the
    first.
13. Each board column scrolls within its own bounded height, and the board's own height does not
    grow with the length of its longest column.
14. A task card does not render its own status as a fact, and every other fact spec 08 asks for
    remains visible without a hover, a click or a disclosure.
15. A card's secondary controls are reachable by keyboard, and opening the disclosure that holds
    them does not stop the board's arrow keys, digits or action shortcuts from working.
16. `POST /api/tasks/:id/undo-status` restores both the previous status and the previous
    `status_set_by`, so a task moved by mistake and then undone is once again a task the
    classifier may act on.
17. Undo is offered for the most recent board status change only, and returns 409 where there is
    nothing to undo.
18. A card whose due date has passed, and a card due today, each render text naming that state;
    a card due later renders the date alone.
19. The dashboard's condensed job rows align column for column whether or not a row carries an
    error, and an error is rendered at the full width available to it.
20. An age of less than a minute reads as "just now" wherever it appears, and never as "just now
    ago".

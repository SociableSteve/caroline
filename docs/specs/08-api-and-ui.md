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
| `GET /api/spend` | What the models have cost this budget period, by day, by purpose and by model, and where each provider stands against its ceiling. Read-only and derived, rolled up from `llm_calls` when it is asked for (spec 03) |
| `GET /api/config` | Read the effective configuration, secrets redacted. Read-only: nothing in `caroline.config.json` is written back from the UI, per spec 09 |
| `GET /api/settings`, `PATCH /api/settings` | The settings the person owns rather than the deployment: today, the name Caroline addresses them by (spec 09) |
| `GET /api/health` | Process, database, per-integration configured and last-run status |
| `GET /api/auth/status` | Whether authentication is required, whether this request has a session, and the provider's label (spec 13). Public |
| `POST /api/auth/login` | Starts the login flow and answers with the provider's authorization URL. Public |
| `GET /api/auth/callback` | The provider's redirect: exchanges the code, checks the identity, sets the cookie. Public |
| `POST /api/auth/logout` | Revokes the session and clears the cookie |
| `POST /api/mcp` | The MCP endpoint, where one is enabled. Its body is JSON-RPC and its semantics are spec 12's. It declares a schema like every other route, and it is criterion 1's one exception in what it answers with: a violation comes back as a JSON-RPC error rather than in the standard error shape, because that shape is the one thing an MCP client cannot parse. Criterion 37 |
| `/api/mcp/authorize` and `POST /api/mcp/token` | The authorisation code flow for an MCP client: the consent screen and the token endpoint (spec 12) |
| `GET /.well-known/oauth-protected-resource`, with and without the endpoint's path appended, and `GET /.well-known/oauth-authorization-server` | The metadata documents a client discovers Caroline through |

Where authentication is required, the API is gated in one place: a single request-level check over
the registered route list, with the three public auth routes above as its only exceptions (spec 13).
`GET /api/health` is not one of them, because it names the version and which integrations are
configured. Nothing outside `/api` is gated, because the SPA shell holds no user content and serving
it is what lets the login screen be a state of the client.

**Every route this API declares is under `/api`, and the metadata documents are the named
exception.** The discovery order a conformant client follows is the path-suffixed well-known
document and then the unsuffixed one, both at the root, so a document served under `/api` is a
document no client looks for. The exception is named here and the test that asserts the prefix
carries it with this reason, rather than being loosened to whatever passes. The MCP endpoint itself
stays under `/api`, which keeps the rest of that assertion true.

The static SPA shell and its assets are not an exception to that, because they are not a declared
route: `@fastify/static` is registered at the root, ahead of everything above, and serves whatever
the built bundle contains. Spec 13 draws the same line for the session check, exempting everything
outside `/api` and naming the shell and its assets as what that means, and this assertion is scoped
the same way for the same reason. Scoping it to the declared routes rather than to the whole
registered route list is deliberate: the wildcard is registered only where a built bundle exists, so
an assertion over everything registered would pass in a CI job with no bundle and be false on a
machine that has one.

Server-sent events are used for chat streaming and for a lightweight change feed the UI
subscribes to, so a background job's results appear without a refresh.

A streamed chat event's name says what the payload is, and the payload is that thing: `event: change`
carries the change record itself, and only the event that names two things carries an object of them.
The records are the same ones the history routes return, so a live turn and a reopened one are
rendered by one piece of code. Both ends have to agree about which events are which shape; where they
did not, a turn arrived with the record missing and the rail rendered nothing.

## UI

Five surfaces and a companion.

**Dashboard.** The morning question is "what am I doing today, and does it fit". The dashboard
answers that first and everything else after, in three bands, in this order. The bands are fixed
rows rather than one reflowing grid, because a reading path that changes with the window width is
not a reading path.

1. **Today.** The verdict, the day bar, and one time-ordered agenda merging the plan's entries
   with the calendar's events. Leads, at the full width of the surface, because it is the answer to
   the question the surface exists to answer. The day bar is the working window drawn to
   wall-clock scale, left to right: meetings, planned work and what is already done each sit at
   their own offset into the window and are drawn at their own duration, and every stretch of free
   time is drawn at its own true width rather than merged into one, so a fragmented afternoon reads
   as fragmented and a three-minute crack reads as unusable. The present moment is a position on
   it. The agenda underneath prints the clock times of the same placements, so the two cannot
   disagree about when something is happening.
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

**Board.** One column per status: Inbox, Next actions, Review, Waiting for, Blocked, Someday,
Reference. Drag between columns to set status, which marks the change as user-set. Inbox
items carrying a low-confidence proposal show it inline with accept and dismiss.

Blocked is the seventh, and it is a deliberate change to the argument this spec used to make for
six. Blocked work that is not reviewable on its own is blocked work that gets buried, which is the
failure the state exists to prevent, and a collapsed section at the foot of Next actions is only a
new place to bury it. The column is a review surface rather than a count: each card names the task
it is blocked behind, so a blocker parked in Someday reads as an indefinite wait rather than an
imminent one.

The Blocked column takes no drag and no digit. A task is blocked by naming its blocker, not by
being moved, and the board has no blocker to name, so offering the move would offer a status the
write would refuse. Out of the column is ordinary: dragging a card out, or filing it anywhere else,
clears the blocker with the status (spec 01).

Columns are columns. Where they do not all fit at the width available, the board scrolls
sideways within its own region; it never wraps some of them onto a second row. A wrapped column
is below and to the left of a column it is logically to the right of, which puts the layout in
direct contradiction with the arrow keys, and the keyboard is the point of this surface.

Each column scrolls on its own within a bounded height. Without that the page grows to the length
of the longest column, two columns of very different lengths cannot be compared, and the status a
card should move to may be off the bottom of the screen when the card is in view. Below the
breakpoint where the columns stop being usable side by side, they stack and each is read whole.

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

**The rail, and what is in it.** The right rail has two regions, stacked: the details of the item that
is open, above the conversation. One rail rather than two, because a details column beside a chat
column costs roughly 38rem, which at 1440px leaves the board scrolled sideways more or less
permanently. Stacking them also does the work a label would otherwise have to do, since the thing
being discussed sits directly above the thing discussing it.

Which items open a panel: tasks and projects, and nothing else. The test is not whether an item has
fields worth showing but whether the conversation can then do anything with it, and every tool in
spec 07's registry addresses a task or a project. A calendar event, a job run and a plan entry have
none, so selecting one would send the model context it cannot act on. A plan entry is not a fourth
kind: it names a task, and clicking one selects that task.

The details region is pinned to the top of the rail and capped at a share of its height, scrolling
within that cap, so a task with long notes never takes the rail from the conversation; in a short
viewport the cap tightens rather than the transcript shrinking. The panel shows the item's own facts
and its provenance, and it is a reading surface rather than a second place to act: the card and the
project row keep the controls, because a control in two places is two places to keep in step.

**The selection model.** The item that is open lives in the URL beside the conversation:
`#/board?item=task:abc` is the board with that task in the rail, and `#/board?item=task:abc&conversation=xyz`
is that task open beside that conversation. It is one of the parameters that describe the rail rather
than the surface, so it survives a reload, a link, and a move to another surface or into a project's
drill-in, for the reason the conversation does. It does not survive the item: an id naming nothing
renders as gone and sends nothing, because a panel that quietly falls back to the last item that did
exist is worse than an empty one.

An open item is the rail open. A hash naming one opens it even where the hash also says `?chat=closed`,
because the panel is inside the rail and an item nobody can see is not open; and closing the rail takes
the item out of the hash along with the conversation, so nothing is left to reopen a rail that was
closed.

Whatever is selected when a message is sent goes to the model as context, which is spec 07's rule and
spec 09's policy. The surface's part of it is that the selection is visible: the card or row that is
open says so, and the panel names the item, so nothing is being sent about an item the user cannot see
is selected.

**Chat, the companion.** Chat is not a surface. It is a rail beside whichever surface is showing,
because asking about the board while the board is on screen is the whole point and a route swap takes
the board away to do it. It holds the transcript, streamed responses, inline records of what changed
with undo, and confirmation prompts for deletes and bulk operations. Earlier conversations are behind
a disclosure within it rather than in a column of their own: a rail is not wide enough for two
columns, and the list is wanted when an earlier conversation is, not while one is being had.

An MCP client's run of calls is a conversation too (spec 12), so it appears in that list, labelled
as one and named with the client that was talking. Labelled rather than behind a filter, because
being in the list beside the rest is what makes it readable and undoable with no new surface, and
a run of writes nobody can find is not an audit trail.
Read-only is stated before anything is typed, and so is a turn that stopped at its tool-call limit.

It is open by default, and closed from its own control or from the header. M10 had it closed until
asked for, on the grounds that a rail always on screen takes its width from the surface whether or
not anything is being asked; driving it settled that the other way. Chat is the thing Caroline is
for, and a rail that has to be opened again on every surface you land on is one that ends up unused.
The width it costs is a width the surfaces are laid out for. Below the width where a rail leaves the
surface usable it collapses to the overlay pattern quick capture already owns: out of the flow, above
the surface, on a raised ground. It is a companion rather than a modal, so nothing behind it is
declared inert.

Whether the rail is open, and which conversation it is reading, both live in the URL, so that a
reload, the back button and a shared link all agree about them. `#/board?conversation=<id>` is the
board with that conversation beside it; `#/board?chat=closed` is the board with the rail closed. It
is the close that the hash records rather than the open, because open is the default and a URL should
not have to say so: `#/board` is the board with the rail open on a conversation nobody has started
yet. A conversation you cannot link to is one you cannot come back to; what it does not have is a
surface of its own, so opening one never takes away the surface it is about.

Both parameters travel with a link from one surface to another. Changing surface is not closing the
companion to the last one, and it is not abandoning the conversation being had about it either: the
rail is beside the surfaces rather than part of any one of them, so it survives a move between them
in whichever state it was left.

**Jobs.** What each background job is for, when it last ran and how that went, when it runs
next, whether a run of failures is holding it back, and a button to run it now. Spec 06 owns
the behaviour; this is where it is discoverable, because a scheduler that says nothing needs a
surface that does. A Model spend panel sits beside the run history, reading `GET /api/spend`:
the period's spend by day, by purpose and by model, and each provider against its ceiling. Spec
03 owns what it says and how it is priced, and the scheduled jobs are what spends most of it, so
this is the surface it belongs on.

**Settings.** Integration status and connect flows, schedules, LLM provider and model,
content policies (spec 09) with their consequences spelled out in plain language, working
hours and reserve, classification threshold.

It is also where an MCP client is approved: the consent screen the authorisation flow lands on,
naming the client asking, and a list of the clients already approved with a way to revoke one.
That is the surface's second write path after the user's name, and it is here rather than in a
client's own interface because an approval decided anywhere else is an approval Caroline cannot
show you afterwards.

**The header, and Sync now.** The header carries the five links and three controls that work from
every surface: Sync now, Quick capture and Chat. Sync now is the manual trigger spec 06 asks be
first-class, for when you know something has just landed, and a trigger that says nothing when it is
pressed is not first-class: a click that changes nothing about the control is indistinguishable from
a missed click, and the natural response to it is a second click.

So the control reports the run. The press is acknowledged at once, before the request answers,
because the request does not answer until the sync has finished; while a run is going the control
says so and is not pressable, so a second press cannot ask for a second run; and between runs it
says how the last one went and when, which is what tells the reader a failed sync failed rather than
stalled. A failure leaves it pressable, because the answer to a failed sync is usually to try again.

What is said out loud is narrower than what is on the screen. The words sit in a live region, so a
screen reader is told about them whenever they change, and what is worth being told is that a run
started and that one finished. How long ago the last one finished is not: the age is counted in
whole minutes and the surfaces re-read the clock every minute, so an age inside the live region
would announce itself roughly once a minute, forever, with nothing having happened. The age is
therefore rendered beside the region rather than inside it, where it is read on demand and never
volunteered.

What it reports is the sync job's own state, read from `GET /api/jobs/status` alongside everything
else the client loads, rather than a second idea of its own kept beside the scheduler's. The
scheduler is the one authority on whether a job is going (spec 06), so a run the scheduler started
reads in the header exactly as one the button started, and the header cannot claim the machine is
idle while a scheduled sync is under way. The one piece of state the header does keep is the gap
between the press and the first answer from the server, which is what makes the acknowledgement
immediate; it is folded into the scheduler's answer rather than substituted for it.

How the SPA authenticates itself is **spec 13's, and is settled there rather than here.** An earlier
draft of this paragraph had the SPA carrying a configured access token on every request and on the
change feed, which assumed a page with no login had been given the token somehow and said nothing
about how. Spec 13 answered it by removing the token instead (its criterion 7) and giving the browser
a session cookie behind a login, with the shell and its assets served without one (its criterion 8).
Nothing about the MCP endpoint's own credential changes with that: the two are separate, and spec 12
says which is which.

### Interaction rules

- Keyboard first on the board: move between items, change status, complete, capture, open the details
  of the focused item.
- A task is opened by clicking its title, not by a control added beside the others: a card's action row
  is already at the width it can afford, and the title is the thing being pointed at. A project's name
  is already a link to its own drill-in, so a project is opened from a control in its row instead,
  where a list has the width a card does not.
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
here is the behaviour each surface owes the reader; what is there is what they all have in common.

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
   error shape. Extended in place, rather than joined by a criterion that would leave two places
   saying what the shape is: `POST /api/mcp` still declares a schema and still refuses a violation,
   but answers it as JSON-RPC, and it is the only exception. Criterion 37 states it.
2. `GET /api/config` never returns an API key, token or refresh token, in any field.
3. Moving a task between board columns results in `status_set_by = 'user'`.
4. The dashboard renders correctly with no plan, no calendar and no integrations
   configured, showing empty states rather than errors.
5. A background job completing updates the open UI without a manual refresh.
6. The day bar's numbers match `GET /api/calendar` for the same date: the window and the reserve
   are that route's own figures rather than anything recomputed on the client, the meetings figure
   is the same total arrived at equivalently (re-summed from the `capacity.busy` intervals the route
   returned, rounded the same way `busyMinutes` is, so it is the route's number by another path),
   and the planned, done and unplanned figures come from walking the plan's own estimates through
   that route's free intervals. (Named the capacity bar until issue #67 redrew it as a clock; the
   same contract.)
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
12. The board renders all its columns on one row, or scrolls sideways with all of them still on
    one row, or stacks them; it never renders some columns on a second row while others share the
    first. Extended in place from "all six" when Blocked made it seven, because the contract is
    the same one and it was never a claim about the number.
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

The chat rail adds the following, appended for the same reason.

21. The navigation lists five surfaces and no chat route, and `#/chat` resolves to the dashboard as
    any other unrecognised hash does.
22. The rail opens beside every surface without replacing it: with the rail open on the board, a card
    on the board is still rendered.
23. A hash naming a conversation opens the rail on it, and closing the rail removes it from the hash,
    so a reload does not reopen a conversation that was closed.

Driving M10's rail in a browser found two defects. Their fix adds the following, appended for the
same reason.

24. A hash that says nothing about chat loads with the rail open beside the surface; only
    `?chat=closed` loads with it closed, and a close writes that parameter.
25. Following a link from one surface to another leaves the rail as it was, open or closed, and keeps
    the conversation it was reading.
26. Sending a message renders the turn: the user's message, the answer as it streams, and the
    recorded turn that replaces it, with the surface beside the rail still on screen throughout.

The details panel adds the following, appended for the same reason.

27. Clicking a task's title on the board opens that task in the rail without leaving the board, and
    the card says it is the one that is open.
28. A hash naming an item opens the rail on that item's details, whether or not the hash also asks for
    the rail to be closed, and closing the rail removes the item along with the conversation.
29. A hash naming an item that no longer exists renders as gone rather than as another item's details.
30. The details panel and the conversation are both in the rail, the panel above the conversation, and
    the panel is bounded and scrolls within its own region rather than taking the rail's height.
31. Clicking a plan entry's title on the dashboard opens the entry's task, and an entry whose task has
    been deleted is not clickable.
32. A link into a project's drill-in, and the link back out of it, each keep whatever the rail is
    doing, so an open conversation and an open item both survive the move in either direction.

Authentication (spec 13) adds the following, appended for the same reason.

33. The login screen is what the shell renders when the API says the request is unauthenticated,
    and it is not a surface: the navigation still lists five, and no auth route resolves in the
    hash.
34. A deep link followed while unauthenticated returns to that same hash once the login succeeds.
35. A 401 from any call puts the app into the login state rather than retrying the call.

The MCP endpoint adds the following, appended for the same reason.

36. Every route this API declares begins with `/api`, except the well-known metadata documents named
    above, which are served from the root because that is where a client's discovery order looks for
    them. The MCP endpoint itself is under `/api`, and the exception is a named list rather than a
    relaxed assertion. The assertion is over the declared routes and says so, because the static
    shell is registered at the root by `@fastify/static` and only where a built bundle exists: an
    assertion over the whole registered route list would be false on a machine with a bundle and pass
    in a job without one, which is the worst of both. Spec 13 criterion 8 is the counterpart that
    says what is true of the shell, namely that it is served without a session while everything under
    `/api` but the three public auth routes is not.
37. `POST /api/mcp` is criterion 1's one exception, as a named list rather than a relaxed assertion:
    it declares a schema like every other route, and a request violating it is answered as a JSON-RPC
    error object rather than in the standard error shape, because a JSON-RPC caller cannot parse that
    shape. Criterion 1 holds unchanged for every other route, which is asserted by keeping the
    exception a list of one. Spec 12 states the same resolution from its side as its criterion 43.

Criterion 18 asked only that a due date and a defer-until date be displayed once set; nothing set
either from the UI, short of chat or a direct API call. Issue #44's fix adds the following, appended
for the same reason.

38. Quick capture offers a due-date input and a defer-until date input alongside title, notes and
    project, each a native date control left empty by default; a date given at capture is sent as
    the end of that day for `dueAt` and the start of it for `deferUntil`, and an empty control sends
    neither field rather than a default.
39. A task card's "More" disclosure offers a due-date input and a defer-until date input, prefilled
    from the task where either is already set. Changing one sends the corresponding instant;
    clearing the control back to empty sends `null`, taking the field off the task rather than
    leaving it as it was. This is the same three-state contract `update_task` offers from chat: set,
    change or clear, with an untouched field left alone.

Issue #67 replaced the day bar's proportion chart with the wall-clock timeline band 1 now
describes. That adds the following, appended for the same reason.

40. The day bar is the working window drawn to scale: every element on the track is positioned and
    sized from its own instants as a fraction of `windowStart` to `windowEnd`, so two blocks of
    equal duration are drawn equally wide wherever in the day they fall, and a block of twice the
    duration is drawn twice as wide. There is no minimum width, because a floor would draw three
    unusable minutes as though they were usable, and that time looking unusable is the point.
41. Free time is drawn one element per gap and never merged: a window with several separate
    stretches of free time in it draws one element for each, each at its own width and offset. A
    day of thirty scattered cracks and a day with one long clear stretch do not draw alike.
42. The present moment is drawn as a position on the track when it falls inside the window, and is
    drawn nowhere at all when it falls before the window opens or after it closes: clamping it to
    an edge would say the day had started, or was ending, when it has not. The legend states the
    time in either case.
43. The bar and the agenda place a plan entry at the same time, by construction rather than by
    coincidence: one walk of the plan's entries through `capacity.free` produces the placement that
    the bar draws and the agenda prints a clock time for, so an entry's offset on the track is the
    offset of the time beside it in the agenda.
44. Held back (`reserveMinutes`) is in the legend as a number and nowhere on the track. It is a
    flat percentage of the window held back for interruptions rather than any particular minutes of
    it, so drawing it anywhere on a clock would claim that specific minutes are reserved when none
    are. Where it is a part of the unplanned minutes it is stated inside that item as a slice of
    them (criterion 47) rather than as an item of its own; where it is not, it is an item of its
    own. It is left unsaid entirely when the reserve is zero.
45. The track is decoration: it is `aria-hidden`, and the legend beside it carries every figure in
    words, so nothing on the strip is said in colour alone. The track carries hour ticks and the
    window's own start and end times, so it reads as a clock rather than as an abstract bar.
46. A day that is not a working day draws no track and says why instead. A day whose capacity is
    unverified draws the track and keeps its unverified notice, which is honest because the notice
    says the window was assumed free. Neither falls back to a second, proportional drawing.
47. Every figure in the legend is a total of the minutes the track drew, and none of them is
    clamped to what is left of the day's capacity: planned and done total the entries actually
    placed on the track, at their full estimates, and the unplanned figure totals the gaps drawn
    between them. A plan that overcommits the window therefore reads the same in words as it is
    drawn, where a clamped figure would have described minutes nothing on the screen matched. Held
    back (criterion 44) is the one legend figure with nothing of its own on the track. The verdict
    headline above the bar is a different claim and stays a different number: it weighs the whole
    plan, unplaceable entries included, against the free capacity the API reported, which is the
    window less its meetings and its reserve. The legend therefore does not call its own figure
    free: it is "unplanned", the time actually left on the clock. Where the held-back minutes fit
    inside it, it names them as a part of itself ("unplanned 1 hour 50 min, 1 hour 42 min of it
    held back") so that the two cannot be read as separate slices of the day and added together.
    That containment is conditional and is claimed only where it holds: the planner plans against a
    capacity the reserve has already been taken out of, so a plan that overcommits that capacity
    leaves fewer unplanned minutes than the reserve, and there the legend states the two as separate
    items ("unplanned 1 hour", "held back 1 hour 42 min") rather than assert a containment that is
    false. At the exact boundary, unplanned equal to the reserve, containment holds and the
    containment sentence is what prints. On a day where every entry found a place, the unplanned
    figure is the verdict's spare plus the held back.
48. The unverified-capacity notice appears once on the surface, not once per source. The plan job
    stores it as a warning and the dashboard also reads it from the live capacity, both from
    `unverifiedCapacityNotice` so that the two cannot word the same fact differently (spec 05,
    criterion 10); the surface renders the sentence a single time, and still renders it on a day
    with no plan at all, which is the case the live reading exists for.

Making a sync in progress visible from the header adds the following, appended for the same reason.

49. Pressing **Sync now** is acknowledged before the request answers: the control reports the run as
    under way from the press itself, and is not pressable while it is under way, so a second press
    during a run asks the server for nothing.
50. The header's sync control reads the sync job's state from `GET /api/jobs/status` rather than
    keeping one of its own, so a run the scheduler started reports as under way in the header too.
    Between runs the header says how the last sync went, success or failure, and when, without
    leaving the surface to find out; a failed run leaves the control pressable.
51. The header's sync region announces the change and not the clock. What it carries is that a run
    is going and how the finished one went; how long ago it finished is rendered beside it, outside
    the live region, because the age changes on every minute's tick and a live region carrying it
    would interrupt a screen reader once a minute indefinitely without anything having happened.
    The age stays readable on the surface, so it is available on demand rather than announced.
    Before the first run there is nothing to say, and the region takes no room in the header rather
    than leaving a gap beside the button.

Issue #91 added blocking, and the following with it, appended rather than renumbered for the same
reason.

52. `blockedBy` is on every task the API returns, and settable on create and on patch. Setting it
    files the task as `blocked` and clearing it returns the task to `next_action`, so the two
    never have to be sent as separate changes. A blocker that does not exist, or one that would
    put a task behind itself directly or through a chain, is a 400 saying which.
53. The Blocked column is not a drop target, and its digit does not move a card into it. A card
    leaving the column by any route loses its blocker along with the status, and the card's status
    control offers `blocked` only to a card that is already in it.

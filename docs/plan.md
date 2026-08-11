# Caroline implementation plan

Derived from [docs/specs](specs/README.md). The specs say what the system does; this says
in what order it gets built, with what tooling, and how each piece is proved.

## Tooling decisions

| Choice | Decision | Why |
| --- | --- | --- |
| Runtime | Node 24 LTS or later, ESM | Matches `package.json` `"type": "module"`. Node 24 is the floor because `node:sqlite` is only non-experimental there, from 24.2.0. It runs unflagged from 22.13.0, but on a stability promise nobody made |
| Language | TypeScript, strict | Typed across the sync, LLM and HTTP boundaries where shapes actually bite |
| HTTP | Fastify 5 with typed route schemas | Schema-first validation, and the schemas double as the API contract |
| Database | SQLite via the built-in `node:sqlite` | Synchronous, no server, and no native compilation. Prefer the built-in: `better-sqlite3` would put `node-gyp` and a working compiler between a reader of the setup guide and a running Caroline |
| Migrations | Hand-rolled numbered runner | Half a page of code, runs on startup, idempotent. No framework needed for one user |
| Client | React 19 + Vite, built to static assets served by Fastify | One process, one deployable |
| Tests | Vitest for server and client, Testing Library for components | One runner, watch mode for red-green |
| Lint | ESLint flat config + Prettier | Standard |
| CI | GitHub Actions: lint, typecheck, test, build | Blocking on the branch |

Layout:

```
src/
  server/        fastify app, routes, schemas
  domain/        tasks, projects, statuses. No IO
  db/            connection, migrations, repositories
  actions/       what the routes and the chat tools both do, where it touches the database
  connectors/    github, gmail, gcal + shared sync engine
  llm/           provider interface, adapters, prompts
  chat/          tool registry, turn loop, undo
  jobs/          scheduler, classify, plan, purge
  config/        schema, loading, validation, redaction
web/             react app
test/fixtures/   recorded provider payloads
docs/            specs and this plan
```

## How the work is done

Tests before code, smallest useful red-green step, watcher running. A task is done when its
spec's acceptance criteria have tests asserting them, the suite passes, lint and typecheck
pass, and the spec still matches what was built. If implementation reveals the spec is
wrong, the spec changes first, in the same commit.

No milestone is merged in a state that leaves `npm start` broken.

## Milestones

### M0. Skeleton

Scaffold TypeScript, Vitest, ESLint, Fastify, Vite, GitHub Actions. Config loading with
schema validation and secret redaction (spec 09), `/api/health`, and a server that starts
with nothing configured and says so.

Exit: `npm test`, `npm run lint`, `npm run build` and `npm start` all work on a clean
checkout with no credentials. Overview criteria 1 and 2 covered.

### M1. Task model and persistence

Migration runner, schema for `projects`, `tasks`, `task_tags`, `sources`. Repositories.
Domain rules: status defaults, the `status_set_by` protection, sync tracking and the rule
that opting out is permanent until re-enabled, derived next action, stalled projects,
deferral, project deletion orphaning rather than cascading.

Exit: every acceptance criterion in spec 01 has a test. Domain logic has no IO in it.

Two criteria straddle a milestone boundary, so their tests are split rather than their
behaviour. Criterion 2 has its rule tested here (a classifier proposal against a
`status_set_by = 'user'` task changes nothing); recording that proposal is asserted in M5,
where `classifications` is defined. Criterion 5 has the query-level exclusion tested here;
the planner honouring it is asserted in M6. Both rules ship in M1 either way.

### M2. API and board UI over manual tasks

Task and project routes with schemas, the standard error shape, the change feed. React app
with the board, quick capture, keyboard operation, project view. No integrations, no LLM.

Exit: a usable manual GTD app. Spec 08 criteria 1, 3, 4 and 8 covered. This is the first
point worth actually running day to day.

### M3. Sync engine and GitHub

The connector interface, upsert by `(provider, external_id)`, content hashing, requeue
rules, resolution handling, per-connector failure isolation, `job_runs`. GitHub connector
against recorded fixtures: discovery plus refresh passes, the review lifecycle state machine
(`awaiting_review` to `reviewed` to `closed`, and back on re-request or on new commits after
a changes-requested review), the mark-reviewed action, and the PR-size estimate heuristic.

The lifecycle is the piece most likely to be got subtly wrong, so it gets a fixture-driven
table test walking a PR through every transition and asserting the visibility guarantee at
each step.

Exit: spec 02 criteria 1 to 18. Review and Waiting for columns populated from real data,
with a PR followed from request through review to merge without ever leaving view.

### M4. LLM provider

The `LlmProvider` interface, schema validation with one retry, the three adapters, the
`llm_calls` table, a fake provider for tests. No feature consumes it yet.

Exit: spec 03 criteria, including the assertion that no vendor type escapes
`src/llm/adapters/`.

### M5. Gmail, classification, scheduler

Gmail OAuth flow and connector. Content policy assembly (spec 09) applied at both the store
and send boundaries, with tests inspecting the built request. Classifier, confidence
threshold, proposals UI, `classifications` audit table, versioned prompt. Scheduler with
overlap prevention, collapsed catch-up, backoff, run history and the jobs UI.

Exit: specs 04 and 06 in full, spec 09 criteria 1 to 6 and 9. The inbox now empties itself.

### M6. Calendar and daily plan

Calendar connector, `calendar_events`, capacity computation (union of busy intervals,
window clipping, free and declined exclusion, reserve). Planner with the post-model rules
enforced in code, plan history, dashboard with the capacity bar and calendar column.

Exit: spec 05 in full, spec 08 criteria 4 and 6.

### M7. Chat

Tool registry, streamed turns over SSE, inline change records, undo via stored inverse
operations, confirmation for deletes and bulk operations, tool-call cap, read-only
degradation when the model cannot call tools, conversation persistence.

Exit: spec 07 in full.

### M8. GitHub notification emails as a backup source

A GitHub notification email about a pull request is not work in its own right: it is a second
telling of something the GitHub connector already covers. Today it lands in the inbox and the
classifier has to guess at it, which produces a duplicate of a card that is already on the
board, or worse a task for a pull request nobody is being asked to review.

Treated instead as a backup source for the GitHub connector, whose discovery query can miss a
pull request: a review requested through a team whose membership the token cannot see, a
repository outside the search's reach, a request made while a sync was failing.

The rule, in the order it is applied to a Gmail thread identified as a pull request
notification:

1. The pull request is already a `github` source. The email is redundant. Suppress it: no
   task, and an existing inbox task for the thread is retired rather than left as a duplicate,
   but only while that task is still untriaged. A thread the user has filed themselves is their
   decision, and rule 3 below applies to it whole.
2. It is not. Fetch that pull request by id through the GitHub connector's refresh path and
   let the ordinary review lifecycle decide whether it belongs in Review at all. Then suppress
   the email exactly as above.
3. It is not a pull request Caroline can resolve, or GitHub refuses the fetch. Leave the
   thread alone and let it be classified as any other email would be. A backup source that
   swallows mail when it cannot do its job is worse than no backup source.

How the three design questions were settled, now written into spec 02:

- **Identification without a body.** Metadata is enough, and no transient fetch is needed. A
  GitHub notification carries a `Message-ID` of the form `owner/repo/pull/<number>@github.com`,
  which names the repository and the number, says `pull` rather than `issues`, and is not a
  subject line that a reply prefix or a translation rewrites. The thread's `Message-ID` headers
  joined the retained metadata; recognition requires one of them and a sender at `github.com`.
  GitHub Enterprise stays out of scope, as it already was.
- **Suppression is not completion.** `suppressed_at` is its own column rather than a reuse of
  `resolved_at`, because resolution is what proposes completing a task and this must never do
  that. The thread's source is relinked to the pull request's task, so the notification appears
  on that card as provenance, or keeps `task_id` null where the lifecycle gave the pull request no
  task at all. Where an untriaged inbox task already existed for the thread it is retired: deleted,
  which removes the duplicate card and not the record of where it came from. That is the one
  exception to spec 01's rule that sync never deletes a task, and spec 01 now names it as such.
- **The user's own decisions still win.** A thread whose task the user has triaged is neither
  retired nor suppressed. The pull request is still brought in, because that half of the rule is
  about GitHub rather than about their mail.

Exit: a notification email for a pull request already on the board creates nothing; one for a
pull request the discovery query missed brings that pull request in with its GitHub provenance
and no email task beside it, in whatever status its refreshed lifecycle puts it, which is
Review when it is awaiting the user and not otherwise; and a notification Caroline cannot
resolve is classified normally. Spec 02 gains the connector's rule and a criterion per case.

### M9. The design pass

Eight milestones built every panel spec 08 asked for and none of the judgements it did not ask
for. Colour was the only axis anybody tokenised, so the rest were chosen per rule: seven values
of border radius, eight font sizes for five ranks of text, ten spacing values for four ranks of
gap. Spec 08 listed the dashboard's nine panels and assigned no rank, so they render in list
order into one reflowing grid, and the least actionable of them leads a surface about work.

Spec 10 is new and states the scales, the primitives and the appearance rules. Spec 08 gains a
stated hierarchy for the dashboard, column and card rules for the board, and criteria 11 to 20.
Spec 01 gains the previous-status pair that makes a board move reversible, and criteria 8 to 11.

Three slices, in this order, because the first is behaviour-neutral and makes the other two
cheap:

1. **Tokens and primitives.** The four scales, the five primitives, and every surface moved onto
   them. A stylesheet test parses the sheet and fails on a literal length in a spacing, size or
   radius property, so the scales are enforced rather than encouraged. Nothing moves on screen
   except spacing consistency. Spec 10 criteria 1 to 4, and the small defects the sweep reaches:
   the `just now ago` phrasing, sentences used as visible button labels, and the header's
   sideways overflow at 430px.
2. **Dashboard hierarchy.** The three bands as fixed rows, the condensed state strip, and the
   job rows that currently collapse whenever they carry an error. Spec 08 criteria 11 and 19,
   spec 10 criteria 5 and 6.
3. **Board density and reversibility.** Six columns that stay six and scroll independently, the
   redundant status fact dropped, secondary controls behind a per-card disclosure, a due-date
   treatment that distinguishes overdue from today from later, and the undo. The undo is the only
   part of this milestone that reaches the database: a migration adding `previous_status` and
   `previous_status_set_by`, and one route. Spec 08 criteria 12 to 18, spec 01 criteria 8 to 11.

Exit: spec 10 in full, spec 08 criteria 11 to 20, spec 01 criteria 8 to 11. Criteria 1 to 10 of
spec 08 keep their numbers and their tests, because thirty places in the code and the suite cite
them by number.

### M10. The appearance model, the chat rail, and who Caroline is talking to

M9 gave the six surfaces one set of decisions. It did not make those decisions: colour was the
only axis anybody had chosen deliberately, and the rest were consistent rather than considered.
Driving the seeded day in a browser is what settled it. Everything is a box inside a box, `--page`
and `--surface-raised` are the same white so a card exists only because of its outline, there is
one neutral where there should be four, the hierarchy between a surface heading and a panel
heading is 0.25rem wide, four rules set small text in uppercase with tracking, and `.primary` is
accent-coloured text in an outlined box rather than a filled action.

Spec 10's Scales and Primitives sections survive. Its Rules section is rewritten around an
appearance model it never had: elevation rather than outlines, a neutral ramp rather than one
`--line`, weight as the scarce resource rather than everything at 600, and one filled primary per
context. The accent hue does not move. The palette was the one thing that was already right.

**The chat rail.** Chat stops being one of six routes and becomes a rail beside whatever surface
you are on, because asking about the board while the board is on screen is the whole point and a
route swap takes the board away to do it. Below the width where a rail leaves the surface usable
it collapses to the overlay pattern quick capture already owns. Spec 08's "Six surfaces" becomes
five and a companion.

**Who it is talking to.** Two facts go into the shared prompt preamble: that the system is called
Caroline, and the name of the person using it. The second is the one that matters, because without
it the model writes about the user in the third person to the user's own face. The preamble is
shared rather than chat's alone: the planner writes user-facing prose too, and its rationales are
already in the second person without having been told who they are addressed to.

The name is data about a person rather than deployment configuration, so it lives in a `settings`
table and the Settings surface gains its first write path. That avoids making
`caroline.config.json` writable, which would mean rewriting a file somebody hand-edited and
deciding what a restart means for it.

It is also personal data leaving the machine on every call to a remote provider, so it is spec
09's business: the content policy states it, and the payload preview shows it, which is the entire
reason that screen exists. A preview that does not show the name is a preview that no longer
proves what it claims to prove.

Exit: spec 10's appearance model in full, the rail on every surface, and a payload preview that
shows the preamble it will actually send.

### M11. The details panel, and what chat is talking about

Clicking an item anywhere opens its details in the right rail, above the conversation. One rail
rather than two: a details column beside a chat column costs roughly 38rem, which at 1440px leaves
the board scrolled sideways more or less permanently. Stacking them also does the work a label
would otherwise have to do, because the thing being discussed sits directly above the thing
discussing it.

The selected item goes to the model as context, so an open item is what "it" means. That is the
feature, and it is also the part that needs rules rather than good intentions:

1. **Context is per message, not per conversation.** It is resolved when a message is sent, from
   whatever is selected then. Pinning it at the start of a conversation would have the model
   answering about an item that has since been closed.
2. **What was sent is recorded on the turn.** The transcript says which item a turn carried, for
   the same reason every other change chat makes is written down: a conversation you cannot audit
   is one you cannot trust.
3. **Selecting nothing sends nothing.** There is no last-selected fallback. An item you closed is
   an item you stopped talking about.
4. **The content policy governs it.** A task's title and notes are content, and a title here can
   carry a client's name. Spec 09 states which fields go, at which content level, and the payload
   preview shows a real one.

Open, to settle in the spec before anything is built: which items get a details panel (tasks
certainly; projects, calendar events, job runs and plan entries are each arguable and each a
different panel), whether selection survives a surface change or a reload, and what a short
viewport does when the details and the conversation both want the height.

Exit: spec 07 gains the context rule and its audit record, spec 08 gains the rail's second region
and the selection model, spec 09 gains the item-as-context policy.

### M12. Release readiness

Setup guide covering the Google Cloud project and OAuth consent, the GitHub token scopes
and provider configuration. Content-policy documentation with the payload preview. Deletion
command. README, and a first tagged release.

Exit: someone other than the author can set it up from the documentation alone.

### M13. The public site

A GitHub Pages site: what Caroline is, how to get started, and the documentation. It renders what
M12 writes rather than restating it, because a setup guide maintained in two places is a setup
guide that is wrong in one of them. It inherits M10's tokens, so the site and the application look
like one thing rather than two.

The repository is public and has no Pages site configured, so there is nothing to unpick first.

Exit: a stranger can find out what Caroline is, decide whether they want it, and set it up,
without being sent to a README in a source tree.

## Test strategy

- **Domain**: pure unit tests, no database.
- **Repositories and jobs**: integration tests against a temporary SQLite file per test,
  real migrations, no mocking of the database.
- **Connectors**: recorded fixtures, no network in the suite ever. Fixtures are scrubbed of
  real addresses, names and repository identifiers before being committed.
- **LLM**: a fake provider returning canned structured responses. Adapters tested against
  recorded provider payloads. No test calls a real model.
- **HTTP**: `fastify.inject`, asserting status, schema conformance and the error shape.
- **UI**: Testing Library for the board interactions and keyboard paths.
- **Security**: dedicated tests asserting no secret reaches a log line or response body, and
  that built LLM request payloads honour the content policy.

## Risks

| Risk | Handling |
| --- | --- |
| Workspace admin blocks the OAuth client | Verify the Gmail and Calendar consent flow early in M5, before building on it |
| Classification quality is poor at `snippet` | The `classifications` table is the evaluation set; tune the prompt against real corrections before loosening the content policy |
| Gmail thread churn causes reclassification noise | Content hashing plus the rule that only inbox tasks requeue; watch it in M5 |
| Scope creep into write-back | Spec 02 and spec 07 both state it as a non-goal, and the chat tool registry enforces it |

## Open questions, not blocking

1. Do you want a `reference` sink that is genuinely searchable, or is a list enough? M2
   assumes a list.
2. Should the daily plan be regenerated automatically when the calendar changes materially,
   or stay strictly on-demand? Spec 05 says on-demand.
3. Is a desktop notification wanted for a failed job, or is the UI badge enough? Spec 06
   says silent.

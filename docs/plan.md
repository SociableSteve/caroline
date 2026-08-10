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
  connectors/    github, gmail, gcal + shared sync engine
  llm/           provider interface, adapters, prompts
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
   task, and an existing inbox task for the thread is retired rather than left as a duplicate.
2. It is not. Fetch that pull request by id through the GitHub connector's refresh path and
   let the ordinary review lifecycle decide whether it belongs in Review at all. Then suppress
   the email exactly as above.
3. It is not a pull request Caroline can resolve, or GitHub refuses the fetch. Leave the
   thread alone and let it be classified as any other email would be. A backup source that
   swallows mail when it cannot do its job is worse than no backup source.

Design questions to settle before building it:

- **Identification without a body.** The default content policy stores no message body
  (spec 09), so detection has to work from what the metadata carries: the sender, the
  `List-ID`, and the subject. Whether that is enough to recover the repository and number, or
  whether the connector has to fetch the thread transiently the way classification does, is
  the first thing to establish.
- **Suppression is not completion.** Retiring the email task must not read as work done. It is
  nearer to the Gmail resolution path than to a user completing something, and it needs to be
  visible on the pull request's card as its provenance rather than silently vanishing.
- **The user's own decisions still win.** A thread the user has already triaged themselves is
  not something a later sync gets to retire, which is spec 01's rule and applies here whole.

Exit: a notification email for a pull request already on the board creates nothing; one for a
pull request the discovery query missed puts that pull request in Review with its GitHub
provenance and no email task beside it; and a notification Caroline cannot resolve is
classified normally. Spec 02 gains the connector's rule and a criterion per case.

### M9. Release readiness

Setup guide covering the Google Cloud project and OAuth consent, the GitHub token scopes
and provider configuration. Content-policy documentation with the payload preview. Deletion
command. README, and a first tagged release.

Exit: someone other than the author can set it up from the documentation alone.

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

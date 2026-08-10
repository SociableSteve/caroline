# Caroline

A single-user, self-hosted GTD system. It collects work from GitHub, Gmail and Calendar,
keeps the inbox sorted with an LLM, and proposes a daily plan that fits the free time
actually available.

See [docs/specs](docs/specs/README.md) for what it does and [docs/plan.md](docs/plan.md)
for the order it gets built in. This is milestone M5: the manual GTD app of M2, the GitHub
connector of M3, the LLM provider of M4, and now Gmail, the inbox classifier and the scheduler.
Review requests and mail threads arrive on their own every quarter of an hour, the inbox sorts
itself hourly, and anything the classifier is unsure of waits on the card for a one-click
accept. The calendar and the daily plan are still to come (M6), and so is chat (M7).

## Running it

Node 24 or later, which is where the built-in `node:sqlite` stops being experimental (Node
24.2.0). There is no native module to compile.

```sh
npm install
npm run build
npm start
```

With nothing configured, the server starts, serves the UI and reports every integration as
"not configured". No credentials are needed to run it. The SQLite database is created at
`./data/caroline.db` on first run and migrated on every start.

For development, run the API and the client separately:

```sh
npm run dev      # API on http://127.0.0.1:5123, restarting on change
npm run dev:web  # Vite dev server, proxying /api to the above
```

## Configuration

Defaults in code, overridden by `caroline.config.json` in the working directory, overridden
by environment variables. Copy `caroline.config.example.json` to get started. Secrets are
read from the environment only: a key in the config file is a startup error.

| Variable                                                               | Purpose                                                   |
| ---------------------------------------------------------------------- | --------------------------------------------------------- |
| `CAROLINE_CONFIG`                                                      | Path to the config file. Default `./caroline.config.json` |
| `CAROLINE_HOST`, `CAROLINE_PORT`                                       | Bind address and port                                     |
| `CAROLINE_ACCESS_TOKEN`                                                | Required to bind to anything other than loopback          |
| `CAROLINE_DB_PATH`                                                     | SQLite file location                                      |
| `CAROLINE_LLM_PROVIDER`, `CAROLINE_LLM_MODEL`, `CAROLINE_LLM_BASE_URL` | LLM selection                                             |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`                                  | LLM key for the selected provider                         |
| `GITHUB_TOKEN`                                                         | Fine-grained personal access token, read-only             |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`                             | OAuth desktop client from your Google Cloud project       |
| `CAROLINE_LOG_LEVEL`                                                   | Pino log level. Default `info`                            |

`tasks.waitingStaleDays` sets how long something may sit in Waiting for before it is called
out as gone quiet, in the column and on the dashboard. Seven days by default, per
[spec 02](docs/specs/02-ingestion.md).

`integrations.github.returnToReviewOnNewCommits` decides whether a pull request you asked
for changes on comes back into Review when the author pushes, or waits for an explicit
re-request. On by default.

`chat.maxToolCalls` bounds how much one chat turn may do: twenty-five tool calls by default, after
which the turn stops and says so. `chat.bulkConfirmThreshold` is how many tasks a turn may change
before the rest of it is held for you to confirm, ten by default.
`chat.contextMessages` is how many earlier messages of a conversation are sent with a turn; the
transcript is kept whole either way.

`jobs.schedules` sets when each background job runs, in cron syntax, read in `jobs.timezone`
so that a daily job stays where you put it across a clock change. `jobs.retainRunDays` is how
long the run history is kept, and `jobs.backoffCeilingMinutes` how far a run of failures may
push the next attempt back. `classification.confidenceThreshold` is the line between an answer
the classifier applies and one it leaves for you: 0.75 by default, per
[spec 04](docs/specs/04-classification.md).

### GitHub

Set `GITHUB_TOKEN` to a fine-grained personal access token with `pull_requests: read` and
`metadata: read` on the organisations you review for. Read-only: Caroline never writes to
GitHub, so there are no comments, no approvals and no labels.

With a token set, a sync runs when the server starts and whenever you press **Sync now**, and
each run does two passes: it searches for open pull requests requesting your review, then
refetches every one it already knows about. The second pass is the important one. A review
request disappears from GitHub's search the moment you submit a review, so without it a pull
request would vanish from Caroline exactly when it became somebody else's turn.

A review card carries **Mark reviewed** (`r` from the keyboard), which moves it to Waiting
for and stamps where the pull request was when you acted. It comes back to Review only if
your review is re-requested, or if the author pushes after you asked for changes. An open
pull request is never completed and never hidden: completion is proposed only when it merges,
closes, or your review request is withdrawn before you ever reviewed it.

### Gmail

Gmail needs an OAuth desktop client from a Google Cloud project of your own. Put its id in
`integrations.google.clientId` and its secret in `GOOGLE_CLIENT_SECRET`, add
`http://127.0.0.1:5123/api/integrations/google/callback` to the client's redirect URIs, then
open **Settings** and press **Connect Google**. The scopes are read-only, `gmail.readonly` and
`calendar.readonly`, and the tokens are written to `google-tokens.json` beside the database with
mode 0600.

`integrations.google.gmailQuery` decides what is in scope, defaulting to
`in:inbox -category:promotions -category:social`. One task per thread, into the inbox. A thread
that leaves the query's results, because you archived it in Gmail, has its task's completion
proposed: triaging in Gmail is not lost work.

### The inbox classifier

With an LLM provider configured, the hourly tick sorts the inbox. An answer at or above
`classification.confidenceThreshold` is applied and attributed to the model; below it, the task
stays in the inbox and the card carries the suggestion, its reasoning and how confident it was,
with **Accept** (`a` from the keyboard) and **Dismiss**. Accepting makes the status yours, which
locks the classifier out of that task from then on. It never proposes completing anything, and it
never creates a project: a project it thinks you need is a suggestion on the card.

Every answer is recorded, applied or not, including the ones that failed. That table is the audit
trail and the evaluation set for tuning the prompt later.

### Chat

**Chat** discusses and changes your tasks in words: triage a pile of inbox items, reshape a project,
ask what today looks like and why. The model is given tools that reach Caroline's own database and
nothing else, so it can search, read, create, update, complete, delete and replan, and it cannot
send an email, comment on a pull request or touch your calendar. The tool list is the enforcement,
not a rule it has been asked to follow.

Every change it makes is yours: it happens at once, appears in the transcript as a line saying what
changed, and the turn carries an **Undo these changes** control that puts the whole batch back.
Deleting is different: it is never carried out on the model's word, and neither is the rest of a turn
that has already changed more tasks than `chat.bulkConfirmThreshold`. Those are proposed, with a
count of what they would affect, and wait for **Confirm** or **Discard**.

Conversations are kept, listed by what they were about, and reopen with their full transcript and
what each one cost in tokens. A turn is recorded as it happens, so a dropped connection loses the
live text and nothing else: reload and it is there.

With a model that cannot use tools, chat says so at the top of the surface and answers from the
counts, the plan and the capacity it is given rather than pretending to make changes. For Ollama
that is the default, because tool support depends on the model: set `llm.supportsTools` to `true`
once you know yours calls them, or set it under `llm.overrides.chat` for the chat model alone.

### The scheduler

Sync runs every fifteen minutes, classification hourly, and a purge nightly. **Jobs** shows what
each one is for, when it last ran and what it did, when it goes next, and whether a run of
failures is holding it back. Every job can be run on demand from there, by the same path a
scheduled run takes. A job already running is not started twice, a day of downtime produces one
catch-up run rather than ninety-six, and nothing notifies you: the run history is the record.

### Using the board

The board is operable from the keyboard alone: arrow keys or `h j k l` to move between
cards and columns, `1` to `6` to move the focused card to that column, `d` to complete it,
`r` to mark a review done, `a` to accept the classifier's suggestion, and `c` to capture
something new from anywhere. Dragging a card
between columns does the
same thing as the digit. Either way the change is recorded as yours, and the classifier will
not later overrule it.

### What leaves the machine

Chat is subject to the same policy. A turn is given counts, today's plan and today's free time, and
no task detail at all: anything more specific the model fetches with a tool, which reads the
database rather than an inbox, and no tool returns a stored message body.

`privacy.llmContent` governs how much of an item is sent to the LLM provider, and
`privacy.storeContent` how much is kept on disk. They are set independently and default to
`snippet` and `metadata`. Sending complete bodies to a hosted provider additionally
requires `allowFullContentToRemoteProvider`, and startup fails if it is not set. Where more may
be sent than is kept, which is the default, the body is fetched when the call is built and
nothing is persisted from it.

**Settings** shows the exact payload a classification call would carry, for a real item in your
inbox, under the policy as it stands. A policy nobody can see the effect of is a policy nobody
can check. See [spec 09](docs/specs/09-config-and-security.md).

Caroline binds to `127.0.0.1` and has no login. Binding anywhere else requires an access
token, enforced at startup.

## Development

```sh
npm test         # vitest, server and client
npm run test:watch
npm run lint     # eslint + prettier
npm run typecheck
npm run build
```

Tests come before code. A change is done when the relevant spec's acceptance criteria have
tests asserting them, and lint, typecheck and the suite all pass.

## Licence

MIT.

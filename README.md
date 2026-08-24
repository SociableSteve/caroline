# Caroline

Self-hosted, AI-powered work tracker and planner, private by design. It collects work from
GitHub, Gmail and Calendar, keeps the inbox sorted with an LLM, and proposes a daily plan
that fits the free time actually available.

It runs on your own machine, against your own accounts, with read-only credentials you create.
Review requests and mail threads arrive on their own every quarter of an hour, the inbox sorts
itself hourly, anything the classifier is unsure of waits on the card for a one-click accept, the
day's plan is drawn against your actual calendar, and chat sits in a rail beside whichever surface
you are on. Nothing is written back to GitHub, Gmail or Calendar, ever.

| Documentation                                    |                                                                                                                                                            |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [docs/setup.md](docs/setup.md)                   | Setting it up from nothing: Node, the config file, a model, the GitHub token, the Google Cloud project and OAuth consent, and how to check each part works |
| [docs/using.md](docs/using.md)                   | Using it: capturing, triaging by keyboard, reading the day, and what to say to the chat rail                                                               |
| [docs/content-policy.md](docs/content-policy.md) | What leaves the machine, what stays on it, one item at all four content levels, and how to read the payload preview                                        |
| [docs/specs](docs/specs/README.md)               | What each part is meant to do. The source of truth                                                                                                         |
| [docs/plan.md](docs/plan.md)                     | The order it was built in                                                                                                                                  |

## Running it

Node 24 or later, which is where the built-in `node:sqlite` stops being experimental (Node
24.2.0). There is no native module to compile.

```sh
npm install
npm run build
npm start
```

With nothing configured, the server starts on <http://127.0.0.1:5123>, serves the UI and reports
every integration as "not configured". No credentials are needed to run it, and it is a usable
manual work tracker in that state. The SQLite database is created at `./data/caroline.db` on first
run and migrated on every start.

Adding the integrations is [docs/setup.md](docs/setup.md), which is the guide to follow rather than
this file: it covers the Google Cloud project and OAuth consent, the GitHub token and its
permissions, and what to check after each one.

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
| `CAROLINE_AUTH_CLIENT_SECRET`                                          | Login provider's client secret, where it needs one        |
| `CAROLINE_DB_PATH`                                                     | SQLite file location                                      |
| `CAROLINE_LLM_PROVIDER`, `CAROLINE_LLM_MODEL`, `CAROLINE_LLM_BASE_URL` | LLM selection                                             |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`                                  | LLM key for the selected provider                         |
| `GITHUB_TOKEN`                                                         | Fine-grained personal access token, read-only             |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`                             | OAuth client from your own Google Cloud project           |
| `CAROLINE_LOG_LEVEL`                                                   | Log level, overriding `logging.level`. Default `info`     |

`logging` decides what Caroline keeps about what it did. The log goes to stdout and to a file in
Caroline's own data directory, `data/logs/caroline.log` by default, so a fault that has already
happened can be investigated on a machine nobody was watching. What survives is bounded:
`logging.file.maxBytes` rotates the live file (5 MiB), `logging.file.maxFiles` is how many exist at
once including it (five, so 25 MiB in total at most), and `logging.file.retainDays` ages the rotated
ones out (a fortnight). `logging.file.directory` puts them somewhere else, `logging.file.enabled`
turns the file off, and `npm run delete-data` removes them along with everything else.

`logging.level` sets how much is said, and `CAROLINE_LOG_LEVEL` overrides it. At `info` you get the
boot line, a matched pair per request and each job's outcome; at `debug` you also get the
scheduler's decisions, each connector pass, each model call with its timings and tokens, the
classifier's decision per task and the planner's arithmetic. No item's own text appears in a log
line at any level: ids, counts, statuses and confidences only, which is what keeps a log on disk out
of the content policy's way. [Spec 14](docs/specs/14-operational-logging.md) is the whole of it.

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

`planning.workingWindow` and `planning.workingDays` are the hours and days the planner may fit work
into, 09:00 to 17:30 on weekdays by default, and `planning.reservePercent` is how much of that
window is held back for interruptions, a fifth of it. `planning.defaultEstimateMinutes` is what a
task with no estimate is fitted at, and `planning.countAllDayEvents` decides whether an all-day
event takes the day: off, because a public holiday and a week-long conference are both all-day
events and only one of them means you are busy. `planning.includeReviews` decides whether pull
request reviews are planned at all: on, and somebody whose code review is handled elsewhere turns
it off.

`integrations.google.calendarIds` adds calendars beyond your primary one, and
`calendarLookbackDays` and `calendarLookaheadDays` bound the window read: a day back and a
fortnight forward.

`llm.budget` bounds what Caroline may spend on model calls. One currency and one period for the
install, and a ceiling per provider that is either a positive amount or the literal `unlimited`:

```json
"llm": {
  "budget": { "currency": "GBP", "period": "month", "anthropic": 20, "openai": "unlimited" }
}
```

Every provider defaults to `unlimited`, so a config file that never mentions it behaves exactly as
it always did. `currency` is `USD`, `GBP` or `EUR` and `period` is `day` or `month`, both defaulting
to `USD` and `month`. The ceiling is set in money and enforced in tokens: at startup the amount is
converted into a token allowance using a price table committed to this repository, and the tokens
already recorded for the period are counted against it. Nothing is fetched, so an offline install
behaves the same as a connected one, and the prices are reviewed like any other change here. Reach a
ceiling and the scheduled jobs skip with a reason in the run history while chat says it has stopped
for the period; the other providers are unaffected. **Jobs** shows the spend by day, by purpose and
by model, as an estimate with the date its prices were checked. `0` is rejected rather than read as
either bound, and a model missing from the price table is a startup error only where that provider
has a numeric ceiling. See [spec 03](docs/specs/03-llm-provider.md).

`jobs.schedules` sets when each background job runs, in cron syntax, read in `jobs.timezone`
so that a daily job stays where you put it across a clock change. `jobs.retainRunDays` is how
long the run history is kept, and `jobs.backoffCeilingMinutes` how far a run of failures may
push the next attempt back. `classification.confidenceThreshold` is the line between an answer
the classifier applies and one it leaves for you: 0.75 by default, per
[spec 04](docs/specs/04-classification.md).

### GitHub

Set `GITHUB_TOKEN` to a fine-grained personal access token with **Pull requests: Read-only** and
**Metadata: Read-only**, whose resource owner is the account or organisation you review for. A
fine-grained token reaches one owner's resources, so reviewing across several organisations means a
classic token with the `repo` scope instead: [docs/setup.md](docs/setup.md#5-github) has the detail.
Read-only either way: Caroline never writes to GitHub, so there are no comments, no approvals and
no labels.

With a token set, a sync runs when the server starts and whenever you press **Sync now**. The
header says **Syncing** while a run is going, whoever started it, and says how the last one went
once it is over. Each run does two passes: it searches for open pull requests requesting your
review, then refetches every one it already knows about. The second pass is the important one. A review
request disappears from GitHub's search the moment you submit a review, so without it a pull
request would vanish from Caroline exactly when it became somebody else's turn.

A review card carries **Mark reviewed** (`r` from the keyboard), which moves it to Waiting
for and stamps where the pull request was when you acted. It comes back to Review only if
your review is re-requested, or if the author pushes after you asked for changes. An open
pull request is never completed and never hidden: completion is proposed only when it merges,
closes, or your review request is withdrawn before you ever reviewed it.

### Gmail

Gmail and Calendar need an OAuth client from a Google Cloud project of your own. Put its id in
`integrations.google.clientId` and its secret in `GOOGLE_CLIENT_SECRET`, add
`http://127.0.0.1:5123/api/integrations/google/callback` to the client's redirect URIs, with
whatever `server.host` and `server.port` say if you have changed either, then
open **Settings** and press **Connect Google**. The scopes are read-only, `gmail.readonly` and
`calendar.readonly`, requested together so consent happens once, and the tokens are written to
`google-tokens.json` beside the database with mode 0600. The whole of it, including the consent
screen and the seven-day expiry that catches everybody out, is in
[docs/setup.md](docs/setup.md#6-google).

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
ask what today looks like and why. It is a rail beside whatever you are looking at rather than a
place to go, because asking about the board while the board is on screen is the whole point. Open it
from the header, on any surface; the conversation keeps a URL, so a link to one comes back to it. The model is given tools that reach Caroline's own database and
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

With a model that cannot use tools, chat says so at the top of the rail and answers from the
counts, the plan and the capacity it is given rather than pretending to make changes. For Ollama
that is the default, because tool support depends on the model: set `llm.supportsTools` to `true`
once you know yours calls them, or set it under `llm.overrides.chat` for the chat model alone.

### The scheduler

Sync runs every fifteen minutes, classification hourly, the plan at 07:30 and a purge nightly.
**Jobs** shows what
each one is for, when it last ran and what it did, when it goes next, and whether a run of
failures is holding it back. Every job can be run on demand from there, by the same path a
scheduled run takes. A job already running is not started twice, a day of downtime produces one
catch-up run rather than ninety-six, and nothing notifies you: the run history is the record.

### Using the board

The board is operable from the keyboard alone: arrow keys or `h j k l` to move between cards and
columns, `1` to `7` to move the focused card to that column, `d` to complete it, `u` to put its
last move back, `r` to mark a review done, `a` to accept the classifier's suggestion, `Enter` to
open it in the rail, and `c` to capture something new from anywhere. Dragging a card between columns
does the same thing as the digit. Either way the change is recorded as yours, and the classifier
will not later overrule it.

Blocked is the one column neither a digit nor a drag will move a card into. A task is blocked by
naming the task that has to finish first, from the card's **More** disclosure or from chat, and the
status and that reference are one fact rather than two. Completing or deleting the blocker releases
whatever was behind it into Next actions at once, so there is no state left to maintain by hand.
[docs/using.md](docs/using.md#blocking-one-task-behind-another) has the rest.

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

Your name goes out too, and deliberately: **Settings** is where you give it, and without it the
model writes about you in the third person to your face. It is sent in the shared preamble on every
chat and planning call, a remote provider included. Leave the field empty and Caroline neither
addresses you by name nor sends one.

**Settings** shows the exact payload a classification call would carry, for a real item in your
inbox, under the policy as it stands, and the preamble word for word as it will be sent. A policy
nobody can see the effect of is a policy nobody can check. The whole picture, including what an item
open in the chat rail sends and what the audit tables keep, is
[docs/content-policy.md](docs/content-policy.md), and the contract behind it is
[spec 09](docs/specs/09-config-and-security.md).

Caroline binds to `127.0.0.1` and has no login there. Binding anywhere else, declaring a
`server.publicUrl`, or setting `auth.mode` to `"required"` means a login: you prove who you are to
an identity provider you configure, and `auth.allow` says which account is yours. It is enforced at
startup, and a configuration that would expose Caroline without one refuses to start. There is no
shared-secret alternative: a token in an environment variable identifies nobody and cannot be
revoked without a restart. [docs/setup.md](docs/setup.md#8-reaching-it-from-elsewhere) walks through
it, and [spec 13](docs/specs/13-authentication.md) is the contract.

Whatever the configuration, every request has to be addressed to Caroline by a name it answers to:
a loopback name, or the host of `server.publicUrl` where there is one. Otherwise a
name somebody else controls could be pointed at `127.0.0.1` and a page in your own browser would be
talking to your Caroline. The database and the data directory are set owner-only on disk (0600 and
0700), which is the whole of the protection at rest: there is no encryption beyond it. Two limits
come with that. A filesystem that cannot carry those modes gets a warning on stderr rather than a
refusal to start, and only a data directory Caroline creates on that run is set to 0700: a
directory that is already there keeps the permissions it has, including the `./data` of an install
created before this was added. Tighten an existing one yourself with `chmod 700 data`.

### Deleting everything

```sh
npm run delete-data            # says what it would remove, removes nothing
npm run delete-data -- --yes   # removes it
```

The database, the SQLite sidecars a crash leaves behind, the Google token file and the temporary
sibling an interrupted token write leaves, and the log files and their directory: everything Caroline
writes. Anything else in the data directory is left alone and named in the output, and a directory
goes only if Caroline had written something in it and it is empty afterwards. Stop Caroline first.

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

[AGENTS.md](https://github.com/SociableSteve/caroline/blob/main/AGENTS.md) is the working
conventions in full: the order of operations, what has to move with a behaviour change, and the
traps worth knowing before you start.

## Licence

MIT.

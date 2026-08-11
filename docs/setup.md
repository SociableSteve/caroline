# Setting Caroline up

Start to finish, on a machine that has never run it. Nothing here needs a compiler, a container or
a server, and every step is optional except the first: Caroline runs with no credentials at all,
reports each integration as not configured, and is a usable manual GTD app in that state.

Read it in order. Each integration ends with a way to check it actually works before you move on.

| Step | You get | Roughly |
| --- | --- | --- |
| [1. What you need](#1-what-you-need) | Node 24 | 2 minutes |
| [2. Install and first run](#2-install-and-first-run) | The board, quick capture, the keyboard | 5 minutes |
| [3. Where things live](#3-where-things-live) | A config file of your own | 2 minutes |
| [4. A model](#4-a-model) | Classification, the daily plan, chat | 5 minutes |
| [5. GitHub](#5-github) | Review requests on the board | 10 minutes |
| [6. Google](#6-google) | Mail in the inbox, the calendar and capacity | 20 minutes |
| [7. What leaves the machine](#7-what-leaves-the-machine) | A policy you have actually looked at | 5 minutes |
| [8. Checking the whole thing](#8-checking-the-whole-thing) | Confidence | 5 minutes |
| [9. Running it day to day](#9-running-it-day-to-day) | Backups, upgrades, keeping it up | 10 minutes |
| [10. Removing everything](#10-removing-everything) | An empty data directory | 1 minute |

## 1. What you need

- **Node 24.2.0 or later.** `node --version`. That version is where the built-in `node:sqlite`
  stops being experimental, which is what lets Caroline use SQLite with no native module and so no
  compiler at install time.
- **git**, to clone it.
- **A browser on the same machine.** Caroline binds to `127.0.0.1` and has no login. Binding it
  anywhere else is possible and requires an access token, and is not what the rest of this guide
  assumes.

Optional, one per integration: a GitHub account whose review requests you want to see, a Google
account whose mail and calendar you want read, and either an API key for Anthropic or OpenAI or a
local [Ollama](https://ollama.com).

## 2. Install and first run

```sh
git clone https://github.com/SociableSteve/caroline.git
cd caroline
npm install
npm run build
npm start
```

Open <http://127.0.0.1:5123>. You should see the dashboard, with every integration listed as not
configured and nothing captured. That is the expected state of a fresh install and not an error.

Try it before configuring anything, because everything after this point is an addition to it:

- Press `c` anywhere to capture something.
- Go to the board from the navigation, then `j`, `k`, `h` and `l` to move around it and `1` to `6`
  to move the focused card between columns.
- `d` completes the focused card and `u` puts its last move back. The board lists its own keys
  under the columns.

`Ctrl-C` stops it. Nothing is lost: everything is in SQLite as it happens.

## 3. Where things live

| Path | What it is |
| --- | --- |
| `./data/caroline.db` | The database. Created on first run, migrated on every start |
| `./data/caroline.db-wal`, `-shm` | SQLite's write-ahead log, while the process is running |
| `./data/google-tokens.json` | Google's refresh token, mode 0600, written only once you connect. A `.tmp` sibling can survive an interrupted write, holding the same token |
| `./caroline.config.json` | Your settings. Optional: every value has a default |

Those are defaults, not fixed locations. `database.path`, or `CAROLINE_DB_PATH`, moves the database,
and the token file follows it: it is always the database's own directory, which is what "the data
directory" means below. If you move it, back up and delete that directory rather than `./data`, and
if you are not sure which one is in force, `npm run delete-data` prints it before it removes
anything.

Nothing Caroline writes lives outside the data directory, which is what makes
[step 10](#10-removing-everything) one command.

Start your own config file from the example, which states the settings at their defaults. Two of them
it cannot: `jobs.timezone` defaults to whatever this machine thinks it is in, so the example names
Europe/London and you should change it to yours, because it is the zone every schedule is read in;
and `llm.supportsTools` is left out entirely, because its default follows from the provider and
"absent" is a different answer from "false" (see [step 4](#4-a-model)).

```sh
cp caroline.config.example.json caroline.config.json
```

Two rules about it, both enforced at startup:

- **No secrets in it.** API keys, tokens and the Google client secret come from the environment
  only. A key in the file is a startup error naming the environment variable to use instead. The
  file is a natural thing to copy into a git repository or a chat window, and a token in it would
  go with it.
- **It is read once.** Caroline reads the file at startup, so a change to it takes a restart. The
  one setting written from the UI is your name, on the Settings screen, which is why that one lives
  in the database instead.

The environment variables, including which key goes with which provider, are tabulated in the
[README](../README.md#configuration). Keep them wherever you keep such things: a `.env` you source,
your shell profile, or the `Environment=` lines of a service unit.

## 4. A model

Caroline works without one. What needs one is the hourly inbox sort, the daily plan and chat.

| Provider | Set | And in `caroline.config.json` |
| --- | --- | --- |
| Anthropic | `ANTHROPIC_API_KEY` | `"llm": { "provider": "anthropic", "model": "<a model id>" }` |
| OpenAI | `OPENAI_API_KEY` | `"llm": { "provider": "openai", "model": "<a model id>" }` |
| Ollama | nothing | `"llm": { "provider": "ollama", "model": "<a model you have pulled>", "baseUrl": "http://127.0.0.1:11434" }` |

Model ids move faster than this guide can, so take them from the provider's own list rather than
from here. Caroline needs a model that can return structured JSON, which the current hosted models
all do, and for chat one that can call tools.

Two settings worth knowing about:

- **`llm.supportsTools`.** Chat makes changes by calling tools. The hosted providers take tools
  from every model they serve, so this is assumed true for them. With Ollama it depends on the
  model you pulled, so it is assumed false, and chat says at the top of the rail that it can read
  but not change. Set `"supportsTools": true` once you know yours calls them.
- **`llm.overrides`.** `classification` and `chat` each take a partial copy of the `llm` block, so
  a cheap fast model can sort the inbox hourly while a stronger one answers in chat. An override
  inherits everything it does not name.

Restart, then look at the dashboard: the state strip along the bottom lists **LLM provider** as
configured. The end-to-end check is in [step 8](#8-checking-the-whole-thing), once there is
something in the inbox to sort.

## 5. GitHub

Caroline reads two things: the pull requests currently requesting your review, and every pull
request it already knows about, refetched on each run so that one you have just reviewed does not
vanish the moment GitHub stops calling it a request. It never writes: no comments, no approvals,
no labels.

1. Go to **Settings → Developer settings → Personal access tokens → Fine-grained tokens** on
   GitHub, and generate a new token.
2. Set the **resource owner** to the account or organisation whose pull requests you review.
3. Give it, under repository permissions, **Pull requests: Read-only**. **Metadata: Read-only** is
   added for you and is required. Nothing else.
4. Select the repositories, or all repositories of that owner.
5. Put the token in `GITHUB_TOKEN` and restart.

Two things about fine-grained tokens that will otherwise cost you an afternoon:

- **One token, one owner.** A fine-grained token reaches resources belonging to a single user or
  organisation, and Caroline reads one `GITHUB_TOKEN`. If you review across more than one
  organisation, use a classic token with the `repo` scope instead, which is coarser than anybody
  would like and is the only thing that spans owners.
- **An organisation can require approval.** Where its personal-access-token policy says so, your
  token exists but reaches nothing until an owner approves it, and GitHub's refusals read like a
  permissions mistake rather than a pending request.

**Check it:** press **Sync now** in the header, or **Run now** on the sync job under **Jobs**, and
read the run it records. A successful run that found nothing means the token works and nobody is
waiting on you. Anything else is reported on the run itself, in words, including a rate limit and
when it resets.

## 6. Google

Gmail and Calendar are read through an OAuth client belonging to a Google Cloud project of your
own. There is no Caroline-operated client to trust, which is the point, and the cost is this
section.

Read-only scopes, and only two: `gmail.readonly` and `calendar.readonly`. They are asked for
together so that consent happens once. Google classifies them differently, which matters if you ever
publish the app: `gmail.readonly` is a **restricted** scope, whose verification includes a security
assessment, and `calendar.readonly` is a **sensitive** one, which is verification without that.

### 6a. A project with the two APIs enabled

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project. Any name.
2. Enable the **Gmail API** and the **Google Calendar API** for it, from **APIs & Services →
   Library**. A missing one shows up later as a permission error on a job run rather than at
   consent, so do both now.

### 6b. The consent screen

Under **APIs & Services → OAuth consent screen**, which the current console also presents as
**Google Auth Platform** with **Branding**, **Audience** and **Data access** as separate pages:

1. Fill in the app name and your support email.
2. **Audience.** A Google Workspace account can choose **Internal**, which limits consent to your
   own organisation. A personal Google account has only **External**.
3. Add the two scopes, `.../auth/gmail.readonly` and `.../auth/calendar.readonly`, under **Data
   access**. Both are scopes a Workspace administrator can block independently of anything you do
   here, `gmail.readonly` being restricted and `calendar.readonly` sensitive.
4. **External, in Testing:** add your own Google address under **Test users**. Consent fails without
   it. A published app needs no test users, and staying in Testing is the recommendation below, so
   in practice this step applies.

**The one thing worth deciding now.** An External app left in **Testing** gets refresh tokens that
expire after seven days, so Caroline loses its Google connection weekly and you press **Connect
Google** again. Three ways out, in order of how much they cost:

- Live with it. It is one click on the Settings screen, and Caroline says on that screen when it
  was last connected.
- Use an **Internal** audience if you have a Workspace organisation. Internal apps are exempt from
  the seven-day expiry and from the hundred-test-user cap.
- Publish the app and go through verification. For restricted scopes that means a review, which
  for a single-user tool nobody else will ever consent to is not worth starting.

### 6c. The client

Under **Credentials → Create credentials → OAuth client ID**:

1. Application type **Web application**. The flow Caroline runs is the loopback one desktop apps
   use, with PKCE, but the **Web application** type is the one whose redirect URIs you can enter
   and check in the console, and Caroline's redirect has a path.
2. Add one **authorised redirect URI**. With the default host and port that is exactly:
   `http://127.0.0.1:5123/api/integrations/google/callback`
   Google allows plain `http` here only because the host is loopback. If you changed
   `server.host` or `server.port`, the URI changes with them, and Caroline's own Settings screen
   prints the one it will use while no client is configured, which is now: take it from there rather
   than from this page.
3. Copy the client id into `caroline.config.json`:

   ```json
   {
     "integrations": {
       "google": { "clientId": "1234567890-abc123.apps.googleusercontent.com" }
     }
   }
   ```

   Or set `GOOGLE_CLIENT_ID` in the environment, which overrides the file: the client id is not a
   secret, so either place is fine, and keeping the pair together is a reasonable preference.

4. Put the client secret in `GOOGLE_CLIENT_SECRET`. Not in the file: it is a secret, and Caroline
   refuses to start with it there.
5. Restart, open **Settings**, and press **Connect Google**. Google asks you to consent to two
   read-only scopes; agreeing sends the browser back to Caroline, which says it is connected, on
   what date, and lists the scopes it holds.

### 6d. What Caroline then reads

Both are worth narrowing before the first sync rather than after:

- `integrations.google.gmailQuery`, default `in:inbox -category:promotions -category:social`, is
  the Gmail search that decides what is in scope. One task per thread. A thread that leaves the
  result set, because you archived it in Gmail, has its task's completion proposed.
- `integrations.google.calendarIds` adds calendars beyond your primary one, and
  `calendarLookbackDays` and `calendarLookaheadDays` bound the window read, a day back and a
  fortnight forward by default.

**Check it:** **Sync now**, then the board. Threads matching the query arrive in the inbox
column, and the dashboard's capacity bar reflects today's calendar.

## 7. What leaves the machine

Caroline reads a work mailbox, and some of that correspondence concerns clients. Two settings
answer what happens to it, they are set independently, and the defaults are deliberately not the
most useful ones:

- `privacy.llmContent`, default `snippet`: how much of an item goes to the model.
- `privacy.storeContent`, default `metadata`: how much of it is written to disk.

The Settings screen shows, for a real item in your inbox and under the policy as it stands, the
exact payload a classification call would carry, the preamble word for word, and what a chat
message about an open item would send. Look at it once with your own mail in it, before you leave
the classifier running against a hosted provider. That screen is the whole reason the numbers above
are configurable, and [docs/content-policy.md](content-policy.md) is the rest of the story.

While you are on that screen, fill in your name. Caroline sends it in the preamble so the model
writes to you rather than about you, and it is personal data going to a third party, so it is shown
in the same preview as everything else. Leaving it empty is a supported answer and sends nothing
about you.

## 8. Checking the whole thing

- `curl -s http://127.0.0.1:5123/api/health` reports the version, the database and each
  integration.
- **Jobs** lists every background job, what it is for, when it last ran and what it did, when it
  goes next, and whether a run of failures is holding it back. **Run now** on each takes the same
  path a scheduled run takes.
- **Dashboard** should show today's capacity, and a plan once you press **Regenerate** under
  today's plan.
- **Chat**, from the button in the header on any surface, should answer a question about your own
  board. If it says it can read but not change anything, that is `llm.supportsTools` and step 4.
- After the hourly classify job has run, the inbox should be shorter, and anything the model was
  unsure of stays there with its suggestion on the card and an **Accept** button.

## 9. Running it day to day

`npm start` in the checkout is all it is. To have it come back after a reboot, on Linux, a user
service is enough:

```ini
# ~/.config/systemd/user/caroline.service
[Unit]
Description=Caroline
After=network-online.target

[Service]
WorkingDirectory=%h/caroline
ExecStart=/usr/bin/npm start
EnvironmentFile=%h/.config/caroline/env
Restart=on-failure

[Install]
WantedBy=default.target
```

`systemctl --user enable --now caroline`, and `loginctl enable-linger $USER` if you want it running
while you are logged out. Put the secrets in that `EnvironmentFile`, mode 0600. Take the `ExecStart`
path from `command -v npm`: a Node installed through nvm or a version manager is not in `/usr/bin`,
and systemd will not search a path for you.

**Backups.** Stop Caroline and copy the data directory. Copying an open SQLite database with a
write-ahead log alongside it is how you get a backup that restores to a slightly different past
than you expected.

**Upgrades.** `git pull && npm install && npm run build`, then restart. Migrations run on start and
are idempotent, so there is no separate step and no order to get wrong.

## 10. Removing everything

```sh
npm run delete-data            # says what it would remove, removes nothing
npm run delete-data -- --yes   # removes it
```

That is the database, the SQLite sidecars a crash leaves behind, the Google token file and the
temporary sibling an interrupted token write leaves, which holds the same refresh token. Anything
else in the data directory is left alone and named, and the directory itself goes only if Caroline
had written something in it and it is empty afterwards. Stop Caroline first.

Deleting the token file is what revoking Caroline's access locally means. To revoke it at the other
end too, remove the app at <https://myaccount.google.com/permissions>, delete the GitHub token, and
delete the Google Cloud project if it exists only for this.

## Troubleshooting

| What you see | What it is |
| --- | --- |
| `Caroline cannot start: llm.apiKey must not appear in caroline.config.json` | A secret in the config file. The message names the environment variable to use instead |
| `Caroline cannot start: server.host is "0.0.0.0", which is not loopback` | The UI has no login, so a non-loopback bind requires `CAROLINE_ACCESS_TOKEN` |
| `Caroline cannot start: privacy.llmContent is "full" with the remote provider` | Sending whole bodies to a third party needs `privacy.allowFullContentToRemoteProvider` set deliberately. See [content-policy.md](content-policy.md) |
| `EADDRINUSE` on 5123 | Something else has the port. `CAROLINE_PORT` moves it, and the Google redirect URI has to move with it |
| `SyntaxError` about `node:sqlite`, or a version complaint at startup | Node older than 24.2.0 |
| Google says `redirect_uri_mismatch` | The URI registered on the client is not the one Caroline sent. It is `/api/integrations/google/callback` on whatever `server.host` and `server.port` say, and `curl -s http://127.0.0.1:5123/api/integrations/google` (on your own port) prints the exact string Caroline sends, as `redirectUri`: compare it character for character, port included. The Settings screen shows it too, but only while no client is configured, which is before you would ever see this error |
| Google says access blocked, or the app is not verified | An External app in Testing consents only to its listed test users. Add your own address under Test users |
| The Google connection dies about once a week | The seven-day refresh-token expiry of an app in Testing. See [step 6b](#6b-the-consent-screen) |
| A sync run says `GitHub rejected the query: ... not accessible by personal access token` | The token's resource owner is not the owner of those repositories, the Pull requests permission is missing, or an organisation has yet to approve the token |
| A sync run reports a Google permission error | The Gmail or Calendar API is not enabled on the project, or a Workspace administrator blocks the scope |
| Nothing in the Review column | The discovery search finds requests to you and to teams you belong to, on repositories that are not archived. A request made through a team the token cannot see arrives by [the backup source](specs/02-ingestion.md) instead, from the notification email |
| Chat says it can read but not change anything | `llm.supportsTools`, which is false by default for Ollama because it depends on the model. Step 4 |
| The classifier leaves everything in the inbox | Below `classification.confidenceThreshold` the answer is a proposal on the card rather than a move. Accepting one makes the status yours, and the classifier will not overrule it afterwards |

Anything not here is worth reading a spec about: [docs/specs](specs/README.md) states what each
part is meant to do, and the acceptance criteria are the contract the tests hold it to.

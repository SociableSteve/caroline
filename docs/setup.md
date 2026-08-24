# Setting Caroline up

Start to finish, on a machine that has never run it. Nothing here needs a compiler, a container or
a server, and every step is optional except the first: Caroline runs with no credentials at all,
reports each integration as not configured, and is a usable manual work tracker in that state.

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
| [8. Reaching it from elsewhere](#8-reaching-it-from-elsewhere) | A login, if Caroline is not staying on this machine | 15 minutes |
| [9. Checking the whole thing](#9-checking-the-whole-thing) | Confidence | 5 minutes |
| [10. Running it day to day](#10-running-it-day-to-day) | Backups, upgrades, keeping it up | 10 minutes |
| [11. Removing everything](#11-removing-everything) | An empty data directory | 1 minute |

## 1. What you need

- **Node 24.2.0 or later.** `node --version`. That version is where the built-in `node:sqlite`
  stops being experimental, which is what lets Caroline use SQLite with no native module and so no
  compiler at install time.
- **git**, to clone it.
- **A browser on the same machine, unless you set up a login.** Caroline binds to `127.0.0.1` by
  default, and on that bind the socket is the boundary: nothing is asked of a caller. Binding
  anywhere else, declaring a public URL, or asking for one explicitly all require a login before
  Caroline answers anything, and an exposed configuration with no login refuses to start rather
  than serving unprotected. That is [step 8](#8-reaching-it-from-elsewhere), and the rest of this
  guide assumes you are on loopback until you get there.

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

Two lines of JSON on the terminal are what a successful start looks like. The second is the one worth
reading, because it is Caroline saying what it thinks it has been configured with:

```
{"level":30,"time":1786505798936,"pid":17114,"hostname":"laptop","msg":"Server listening at http://127.0.0.1:5123"}
{"level":30,"time":1786505798937,"pid":17114,"hostname":"laptop","version":"1.0.0","database":"/home/you/caroline/data/caroline.db","github":"not configured","google":"not configured","llm":"not configured","llmContent":"snippet","storeContent":"metadata","timezone":"Europe/London","schedules":{"sync":"*/15 * * * *","classify":"5 * * * *","plan":"30 7 * * *","purge":"20 3 * * *"},"msg":"Caroline is running"}
```

Six of those values are this machine's rather than yours: the time, the pid, the hostname, the port, the
database path and the timezone, which defaults to whatever the machine thinks it is in and is the one
thing [step 3](#3-where-things-live) asks you to set deliberately. Everything else on a fresh install
reads as that does: three integrations not configured, the two content levels at their defaults, and the
four schedules.

Anything on the terminal beginning `Caroline cannot start:` is a configuration error rather than a crash,
and it names the setting and what to do about it: there are examples in
[troubleshooting](#troubleshooting).

Open <http://127.0.0.1:5123>. You should see the dashboard, with every integration listed as not
configured and nothing captured. That is the expected state of a fresh install and not an error.

Try it before configuring anything, because everything after this point is an addition to it:

- Press `c` anywhere to capture something.
- Go to the board from the navigation, then `j`, `k`, `h` and `l` to move around it and `1` to `6`
  to move the focused card between columns.
- `d` completes the focused card and `u` puts its last move back. The board lists its own keys
  under the columns.

`Ctrl-C` stops it. Nothing is lost: everything is in SQLite as it happens.

[using.md](using.md) is the tour of what to press once it is running. The rest of this guide is about
giving it something to read.

## 3. Where things live

| Path | What it is |
| --- | --- |
| `./data/caroline.db` | The database. Created on first run, migrated on every start, mode 0600 |
| `./data/caroline.db-wal`, `-shm` | SQLite's write-ahead log, while the process is running, mode 0600 too |
| `./data/google-tokens.json` | Google's refresh token, mode 0600, written only once you connect. A `.tmp` sibling can survive an interrupted write, holding the same token |
| `./data/logs/caroline.log` | The log, rotated at 5 MiB and kept to five files and a fortnight, mode 0600. `logging.file` moves it, bounds it or turns it off |
| `./caroline.config.json` | Your settings. Optional: every value has a default |

Those are defaults, not fixed locations. `database.path`, or `CAROLINE_DB_PATH`, moves the database,
and the token file follows it: it is always the database's own directory, which is what "the data
directory" means below. If you move it, back up and delete that directory rather than `./data`, and
if you are not sure which one is in force, `npm run delete-data` prints it before it removes
anything.

Those modes are set rather than assumed, and two things limit them. A filesystem that cannot carry
them, such as a CIFS or exFAT mount, gets one warning on stderr and Caroline starts anyway, so check
that line if the modes matter to you. And only a data directory Caroline creates on that run is set
to 0700. A directory that is already there keeps the permissions it has, whether it is one of your
own that `database.path` points at or the `./data` of an install created before this was added, so
if the modes matter to you, tighten it yourself: `chmod 700 data`.

Nothing Caroline writes lives outside the data directory, which is what makes
[step 11](#11-removing-everything) one command.

The built SPA (`dist/web`, `npm run build`'s output) is found the same way: relative to the
process's working directory. That is right whenever `npm start` is run from the repo root, which
is every case above, but not every deployment starts it that way: a Docker `WORKDIR`, a pm2 config
or a systemd unit with no explicit working directory can leave Caroline looking in the wrong place
and silently 404ing every page that is not an API route. If that is your setup, set
`server.webRoot`, or `CAROLINE_WEB_ROOT`, to the absolute path of `dist/web`.

Start your own config file from the example, which states the settings at their defaults. Two of them
it cannot: `jobs.timezone` defaults to whatever this machine thinks it is in, so the example names
Europe/London and you should change it to yours, because it is the zone every schedule is read in;
and `llm.supportsTools` is left out entirely, because its default follows from the provider and
"absent" is a different answer from "false" (see [step 4](#4-a-model)).

```sh
cp caroline.config.example.json caroline.config.json
```

Every value has a default, so a file naming only what you changed is a complete file. This is one that
has been through the whole of this guide, and it is about as long as a real one gets:

```json
{
  "jobs": { "timezone": "Europe/Lisbon" },
  "tasks": { "waitingStaleDays": 10 },
  "classification": { "confidenceThreshold": 0.8 },
  "planning": {
    "workingWindow": { "start": "09:30", "end": "17:00" },
    "reservePercent": 25
  },
  "llm": {
    "provider": "anthropic",
    "model": "claude-sonnet-5",
    "overrides": { "classification": { "model": "claude-haiku-5" } }
  },
  "integrations": {
    "google": {
      "clientId": "1234567890-abc123def456.apps.googleusercontent.com",
      "gmailQuery": "in:inbox -category:promotions -category:social -label:newsletters",
      "calendarLookaheadDays": 21
    }
  }
}
```

Read that as: schedules in Lisbon time, a wait is stale after ten days rather than seven, the
classifier only files something it is 80% sure of, a working day of 09:30 to 17:00 with a quarter of
it held back for interruptions, a strong model for chat and a cheap one for the hourly inbox sort, a
Google client id that is not a secret, a Gmail query narrowed by one more label, and three weeks of
calendar ahead instead of two. The two model ids are examples: take yours from the provider's own
list, because they move faster than this guide can.

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

Restart, then open **Settings**: under **GitHub and LLM provider**, the **LLM provider** row reads
`configured`. The end-to-end check is in [step 9](#9-checking-the-whole-thing), once there is
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
column, and the dashboard's day bar reflects today's calendar.

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

## 8. Reaching it from elsewhere

Skip this if Caroline is staying on the machine you installed it on and nothing else is proxying
to it. Everything in this step is about the moment that stops being true.

### What triggers a login, and what happens without one

Caroline is single user, and on `127.0.0.1` the operating system is the boundary: nothing on this
machine but you can open that socket, so nothing is asked of a caller. That stops being true the
moment any of these holds:

- `server.host` is set to anything other than a loopback address (`127.0.0.1`, `localhost`, `::1`
  or `::ffff:127.0.0.1`). `0.0.0.0` and `::` count as not loopback too: they accept connections
  from the network, so a request that happens to arrive over loopback on such a bind still needs a
  session.
- `server.publicUrl` is set. This is how you tell Caroline there is a reverse proxy in front of it:
  the socket may be loopback while the traffic reaching it is not, and no request header can be
  trusted to say so on its own.
- `auth.mode` is `"required"`. This is how you turn a login on for a loopback install that has
  no reverse proxy at all, and it is the only way to get one there.

Once any of those is true, Caroline refuses to start unless a provider is configured
(`auth.provider.clientId`) and `auth.allow` names at least one identity, and, where the bind is not
loopback, `server.publicUrl` is set too. The refusal is a line on the terminal naming the setting
it objected to, in the same shape as the other startup refusals in
[troubleshooting](#troubleshooting): it does not start half-open and it does not guess.

### The address Caroline answers to

Separately from the login, and whether or not you have one, every request has to be addressed to a
name Caroline answers to. That is any loopback name, plus the host of `server.publicUrl` where you
have set one. Anything else is refused with a `403` before the request reaches a route. The hostname
is what is compared and the port is not, so a proxy forwarding the bare name (which is what
`proxy_set_header Host $host;` does) is fine.

This is not the same question as which interface the socket is on. A name in DNS that somebody else
controls can be pointed at `127.0.0.1`, and a page loaded from that name in your own browser is
then same-origin with Caroline and can read and write everything in it, loopback bind or not. The
`Host` header is the one part of that attack the page cannot forge, because the browser writes it
from the address bar, so checking it is what makes the loopback bind mean what it looks like it
means. The MCP endpoint has checked it since it was written; the rest of the API now does too.

In practice: reach a loopback install as `localhost` or `127.0.0.1` (any port), and set
`server.publicUrl` to the address you actually reach an exposed install at. A reverse proxy that
rewrites `Host` to a third name has to be told not to, or told to rewrite it to the public host. The
403 names `server.publicUrl`, because forgetting it is the usual cause. The loopback names keep
working on an exposed install too, which is what lets an MCP client on the machine itself reach
`POST /api/mcp`: that endpoint answers a loopback address and nothing else.

Non-`GET` requests are checked the same way for their `Origin` header where they carry one, again
whether or not a login is configured. Any loopback origin on any port is accepted, along with the
public origin where you have one, which is what keeps `npm run dev:web` working: the client is
served from a different loopback port than the API.

### 8a. A second OAuth client, for login

The Google Cloud project from [step 6](#6-google) can hold this client too, but it has to be a
second one. Reusing the Gmail and Calendar client would mean a loopback redirect, which an exposed
install cannot use, and it would put a login behind a consent screen carrying mail scopes it has
no business asking for. The consent screen from [step 6b](#6b-the-consent-screen) is already in
place; this is just a second credential under it.

1. In the same project, under **Credentials → Create credentials → OAuth client ID**, choose
   application type **Web application**.
2. Add one **authorised redirect URI**: the address you will reach Caroline at, plus
   `/api/auth/callback`. For an exposed install behind a reverse proxy that is your public URL,
   for example `https://caroline.example.com/api/auth/callback`; for a loopback install that has
   turned a login on with `auth.mode: "required"` and no public URL, it is the loopback address
   Caroline is already listening on, for example `http://127.0.0.1:5123/api/auth/callback`.
3. Copy the client id into `caroline.config.json`, under `auth.provider.clientId`:

   ```json
   {
     "auth": {
       "provider": { "clientId": "1234567890-xyz789.apps.googleusercontent.com" }
     }
   }
   ```

4. Put the client secret in `CAROLINE_AUTH_CLIENT_SECRET`, not in the file. Google's own console
   always issues one for a Web application client, so in practice this step is not optional the
   way it can be with some other providers.

### 8b. The rest of the configuration

```jsonc
{
  "server": {
    "publicUrl": null // e.g. "https://caroline.example.com", if there is a proxy in front
  },
  "auth": {
    "mode": "auto", // auto | required
    "allow": [], // your own address, or "sub:<value>"
    "provider": {
      "issuer": "https://accounts.google.com",
      "clientId": null,
      "clientSecret": null // CAROLINE_AUTH_CLIENT_SECRET only, never in the file
    }
  }
}
```

- **`auth.provider.issuer`**, default `https://accounts.google.com`. The OIDC issuer: Caroline
  fetches `{issuer}/.well-known/openid-configuration` from it on the first login attempt to learn
  where to send you and where to exchange the code it gets back. Leave it at the default for a
  Google client.
- **`auth.provider.clientId`** and **`auth.provider.clientSecret`**, from [8a](#8a-a-second-oauth-client-for-login)
  above. `clientId` defaults to `null`, and `null` is what tells Caroline no provider is configured
  at all, which is one of the things an exposed install refuses to start without.
- **`auth.allow`**, default an empty array, and mandatory once a login is required: an entry is
  your own email address, or `sub:<value>` for a provider that does not return one. Signing in
  successfully at Google says only that Google recognises you, not that you own this Caroline, so
  the allowlist is the second decision, and it is Caroline's rather than the provider's. An empty
  allowlist on an install that requires a login is refused at startup: the provider would
  authenticate anybody with a Google account against Caroline's client, and an empty allowlist
  would let every one of them in, which is no authentication at all with the ceremony of one.
  The first successful sign-in from an allowed address is also pinned to the identity that
  signed in, so a later sign-in against the same allowlist entry from a different account is
  refused.

Restart, open Caroline at the address you configured, and you should land on a login screen with
one button naming the provider (`auth.provider.label`, `"Google"` by default) rather than the
board. Signing in with the address in `auth.allow` takes you to it; signing in with anything else
is refused.

**Locked out?** The documented way back in is shell access to the machine: stop Caroline, edit
`caroline.config.json` to put `server.host` back to `127.0.0.1`, remove `server.publicUrl`, and
set `auth.mode` back to `"auto"` if you had set it to `"required"`, then restart. That is a
loopback install with no login again, reachable over an SSH tunnel if the machine is remote, and
you can put the settings back once whatever was wrong is fixed. There is no other recovery path
and no one-time login link.

**Using a different provider?** Google is the worked example above because its console is the one
this guide can walk you through, but the login is built on OIDC discovery, and any provider
offering the authorization code flow with PKCE and a stable `sub` claim works the same way, with
its own issuer and its own client instead. [Spec 13](specs/13-authentication.md#provider-requirements-and-what-cannot-be-generic)
states the generic requirements, if that is what you are setting up.

## 9. Checking the whole thing

- `curl -s http://127.0.0.1:5123/api/health` reports the version, the database and each
  integration. On a fresh install, with nothing configured, this is the answer, wrapped over lines
  rather than the one line it arrives on:

  ```json
  {
    "status": "ok",
    "version": "1.0.0",
    "uptimeSeconds": 4,
    "integrations": {
      "github": { "configured": false, "status": "not configured" },
      "google": { "configured": false, "status": "not configured" },
      "llm": { "configured": false, "status": "not configured" }
    },
    "database": { "status": "ready" }
  }
  ```

  Working through the steps above turns those `false`s into `true`s one at a time, which is what makes
  this the quickest check that a restart picked up what you just set. `"database": { "status": "ready" }`
  means the migrations ran.
- **Jobs** lists every background job, what it is for, when it last ran and what it did, when it
  goes next, and whether a run of failures is holding it back. **Run now** on each takes the same
  path a scheduled run takes.
- **Dashboard** should show today's capacity, and a plan once you press **Regenerate** under
  today's plan.
- **Chat**, from the button in the header on any surface, should answer a question about your own
  board. If it says it can read but not change anything, that is `llm.supportsTools` and step 4.
- After the hourly classify job has run, the inbox should be shorter, and anything the model was
  unsure of stays there with its suggestion on the card and an **Accept** button.

## 10. Running it day to day

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

## 11. Removing everything

```sh
npm run delete-data            # says what it would remove, removes nothing
npm run delete-data -- --yes   # removes it
```

The dry run names the directory first, then every file, and says plainly that it did nothing:

```
Data directory: /home/you/caroline/data

Would remove:
  /home/you/caroline/data/caroline.db
  /home/you/caroline/data/caroline.db-wal
  /home/you/caroline/data/caroline.db-shm

Would remove the empty /home/you/caroline/data

Nothing was deleted. Re-run with `npm run delete-data -- --yes`.
```

Read the directory on the first line before you pass `--yes`. That is the whole point of the dry run:
if you moved the database with `database.path` or `CAROLINE_DB_PATH`, this is the answer to which
directory is in force.

That is the database, the SQLite sidecars a crash leaves behind, the Google token file and the
temporary sibling an interrupted token write leaves, which holds the same refresh token, and the log
files and the directory they sit in. Anything else in the data directory is left alone and named, and
a directory goes only if Caroline had written something in it and it is empty afterwards. Stop
Caroline first.

Deleting the token file is what revoking Caroline's access locally means. To revoke it at the other
end too, remove the app at <https://myaccount.google.com/permissions>, delete the GitHub token, and
delete the Google Cloud project if it exists only for this.

## Troubleshooting

A refusal to start is one line on the terminal, and it names the setting, the value it objected to and
what to do instead. Both of these are real:

```
Caroline cannot start: llm.apiKey must not appear in caroline.config.json. Secrets are read from the environment only: set ANTHROPIC_API_KEY or OPENAI_API_KEY instead.
```

```
Caroline cannot start: privacy.llmContent is "full" with the remote provider "anthropic" at llm.provider, which sends complete message bodies to a third party. Set privacy.allowFullContentToRemoteProvider to true to accept that, or lower privacy.llmContent.
```

Nothing has started and nothing has been written when you see one of those. Fix the setting and run
`npm start` again.

For anything that goes wrong after it has started, the log is the place to look, and it is kept
rather than only printed: `data/logs/caroline.log`, with the boot line naming the path it is actually
writing to. `CAROLINE_LOG_LEVEL=debug npm start` says a good deal more, including why the classifier
decided what it did and what each model call cost, and no item's own text appears in it at any
level.

| What you see | What it is |
| --- | --- |
| `Caroline cannot start: llm.apiKey must not appear in caroline.config.json` | A secret in the config file. The message names the environment variable to use instead |
| `Caroline cannot start: privacy.llmContent is "full" with the remote provider` | Sending whole bodies to a third party needs `privacy.allowFullContentToRemoteProvider` set deliberately. See [content-policy.md](content-policy.md) |
| `Caroline cannot start: ... auth.provider.clientId is not set: there would be no way to log in` | A non-loopback bind, a public URL or `auth.mode: "required"` needs a provider configured. See [step 8](#8-reaching-it-from-elsewhere) |
| `Caroline cannot start: ... auth.allow is empty: the provider would authenticate anybody with an account there` | The allowlist is mandatory once a login is required. Add your own address, or `sub:<value>`. See [step 8](#8-reaching-it-from-elsewhere) |
| `Caroline cannot start: server.host is "...", which is not loopback, and server.publicUrl is not set: the redirect URI cannot be derived` | A non-loopback bind needs `server.publicUrl` set, so Caroline knows the address it is registering a redirect at. See [step 8](#8-reaching-it-from-elsewhere) |
| `Caroline cannot start: server.publicUrl is "...", which is not https, ...: a session cookie would be sent over plaintext` | `server.publicUrl` must be `https` unless both it and `server.host` are loopback. See [step 8](#8-reaching-it-from-elsewhere) |
| `Caroline cannot start: CAROLINE_ACCESS_TOKEN is set in the environment. It has been replaced by a login` | That variable no longer does anything. Remove it and configure `auth.provider` and `auth.allow` instead. See [step 8](#8-reaching-it-from-elsewhere) |
| Every request answers `403` with `This request carries a Host this Caroline does not answer to` | The name in the address bar, or the one your proxy is forwarding as `Host`, is not one this install answers to. Reach a loopback install as `localhost` or `127.0.0.1`, or set `server.publicUrl` to the address you really reach it at. See [the address Caroline answers to](#the-address-caroline-answers-to) |
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
| Testing the Google connect flow while running `npm run dev:web` does not land you back on its hot-reloading UI at 5173 | `redirect_uri` always points at `server.host`/`server.port` (5123 by default): that is the one stable address registered with Google, and it is correct that `dev:web`'s proxy does not change it. Run `npm run build:web`, then restart `npm run dev` so it picks up the newly built SPA (it decides once at startup whether one exists, and only restarts on changes under `src/`), complete the connect flow at 5123, then switch back to `dev:web` for UI iteration |

Anything not here is worth reading a spec about: [docs/specs](specs/README.md) states what each
part is meant to do, and the acceptance criteria are the contract the tests hold it to.

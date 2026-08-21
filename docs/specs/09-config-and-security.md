# 09. Configuration and security posture

## Purpose

Caroline reads a work mailbox. Some of that correspondence concerns clients. Two questions
therefore need an explicit, configurable answer rather than a default buried in code:

1. **What leaves the machine?** How much of an item's content is sent to the LLM provider.
2. **What stays on the machine?** How much of an item's content is persisted in SQLite.

They are set independently, because they carry different risks. Sending a body to a hosted
provider is disclosure to a third party. Storing it is a local retention decision.

## Content policies

```jsonc
{
  "privacy": {
    "llmContent": "snippet",        // none | metadata | snippet | full
    "storeContent": "metadata",     // none | metadata | snippet | full
    "snippetChars": 300,
    "retainContentDays": 30,
    "allowFullContentToRemoteProvider": false
  }
}
```

| Level | Includes |
| --- | --- |
| `none` | Nothing beyond internal ids. Classification is effectively disabled for that source |
| `metadata` | Sender or author, recipients, subject or title, timestamps, labels, PR stats, and the prose Caroline wrote about its own scheduling: a plan's summary and a plan entry's rationale. No body |
| `snippet` | Metadata plus the first `snippetChars` of the body |
| `full` | Metadata plus the complete body |

### Interaction rules

- `llmContent` may never exceed `storeContent` in effect for stored data, but it may be
  computed transiently: a snippet can be sent while nothing is stored. It may never exceed
  what the connector fetched. Transiently means at the moment of sending: where `llmContent`
  exceeds `storeContent`, the connector is asked for the body when the call is built, and
  nothing is persisted from it. The cost is one extra fetch per item classified, which is what
  the default pair buys.
- `llmContent: "full"` with a remote provider (Anthropic or OpenAI) requires
  `allowFullContentToRemoteProvider: true`. Without it, startup fails with an explanation
  rather than quietly downgrading. With Ollama, `isLocal` is true and the guard does not
  apply.
- **An MCP client counts as a remote provider whatever `llm.provider` says**, so `llmContent:
  "full"` with the MCP server enabled requires `allowFullContentToRemoteProvider: true` as
  well, `ollama` included, and startup fails naming all three settings otherwise. The guard is
  otherwise checked against the configured provider's `isLocal`, which is true only for Ollama;
  somebody running Ollama therefore has `llmContent: "full"` with the flag off legitimately,
  and that is safe today because nothing leaves the machine. Enable an MCP server and complete
  bodies can leave through a client whose model Caroline cannot see and has no way to ask
  about, so the local-model exemption has lost its premise on that surface rather than been
  withdrawn arbitrarily. Spec 12 owns the surface.
- **The MCP surface is this same boundary reached through a different port.** `llmContent`
  governs every MCP tool response, by the same functions that answer for chat, and there is no
  second dial: this level names how much of an item may be given to a language model, and the
  destination on both sides is a language model. Two dials would raise which one governs when
  the chat provider and the MCP client are the same model. At `none` an MCP client is answered
  ids and a withholding sentence and is close to useless, which is what the level means rather
  than an exception to carve. Nothing about the person is sent over MCP at all: see below.
- Changing `storeContent` to a lower level purges content already stored above that level
  on the next run, and says how many rows it cleared. Each source row records the level its
  body was written at, because the text cannot say which it is: three hundred characters may be
  a truncated snippet or a whole short body, and a downgrade has to tell them apart.
- A level is a property of the boundary rather than of a route through it. `none` therefore withholds
  an item's own fields from everything that reaches a provider: the item context sent unasked, every
  read tool the model may call, every write tool's answer and the descriptions and refusals it answers
  with, and the turns of the conversation replayed as context. A title, a person's name and a rationale
  written about a task are all the item's; what is not the item's still goes, so a count of matches, a
  day's capacity arithmetic and the order a plan put its entries in are answered as they always were.
  Anything withheld is said to be withheld, so the model asks rather than answering from memory.
- **A write tool is a send boundary too.** It answers with the row it wrote, which is item text the
  model never supplied: at `none` the item context gives it an id and a sentence, and "mark it done"
  would otherwise hand back the title, the name of the person the task waits on and its project. So a
  write tool answers with the ids and the withholding, exactly as a read tool does, and the change
  itself still happens: the policy governs what is said about the work, not whether the work is done.
- **A rationale and a plan's summary are metadata, deliberately.** They are prose Caroline wrote about
  its own scheduling rather than a body somebody wrote about a client's work, and they are the answer
  to the question `get_daily_plan` exists to answer: why the day is in this order. Withholding them at
  `metadata` would leave that tool returning a ranked list of ids with nothing to explain it, which is
  not a level anybody would choose. They can name a task, so at `none` they are withheld with
  everything else. This is a judgement about where one line falls, written down rather than left
  implicit, so that moving it is a decision about a row of a table and not an accident.
- **A stored turn is replayed only as far as the level in force now allows.** A conversation held at
  `snippet` and then lowered to `none` would otherwise send its earlier turns verbatim, titles and note
  excerpts included, which is the disclosure the level was lowered to stop, arriving by the one route
  nobody inspects. So at `none` the turns before this one are not sent, and the model is told they were
  withheld rather than left to conclude the conversation has only just begun. The message just sent is
  the user's own words and goes as it always did. This is the same answer a plan summary drawn before
  the policy was lowered gets, and for the same reason: two stale artefacts cannot get two answers.
  Nothing is deleted by this, because `storeContent` governs the disk and this is the send boundary.
- **A confirmation the user decides on is not a send boundary.** The card asking whether to delete a
  task is rendered on the user's own screen from their own database, so it names the task however low
  `llmContent` is set: a card reading "delete task-1" would only have somebody confirm blind. What the
  model is told about the held operation is a send boundary, and at `none` the operation is named by the
  arguments the model itself supplied. The same holds for the summary recorded against a change for the
  transcript's undo control.

  **That reason is also why elicitation is refused over MCP.** The protocol offers a way to ask the user
  a question through their own client's interface, which looks like the obvious way to confirm a delete.
  It is not: the exemption above exists because the card is rendered on the user's own screen from their
  own database, and asking through the client would push that text out through the client, turning the
  one thing exempt from this policy into a disclosure. So a confirmation is decided on Caroline's own
  screen whichever caller proposed the operation. Written down here rather than left to a later reader
  to take for an oversight.
- `retainContentDays` purges stored `content` older than the window on a daily job. Source
  rows, tasks and metadata survive; only the body text is dropped. Age is measured from when
  the body was written, not from when the item was last seen: a thread still in the inbox is
  seen every fifteen minutes, so the latter would mean no body was ever old enough to purge.

### Defaults

`llmContent: "snippet"`, `storeContent: "metadata"`,
`allowFullContentToRemoteProvider: false`. Sensible for a work mailbox: enough for the
classifier to work, no bodies at rest, nothing full-text sent to a third party without an
explicit decision.

Every settings control that changes exposure states its consequence in plain language, not
just its name. The UI shows, for the current configuration, exactly what a classification
call would contain, using a real item, before it is used.

## What Caroline is told about you

Two facts go into a shared prompt preamble, carried by every call that produces prose a person reads:
that the system is called Caroline, and the name of the person using it. The second is the one that
matters, because without it the model writes about the user in the third person to the user's own
face. The preamble is shared rather than chat's alone: the planner writes user-facing prose too, and
its rationales were already in the second person without having been told who they were addressed to.

- **It is data about a person, not deployment configuration.** The name lives in a `settings` table
  and is written from the Settings surface. That is what avoids making `caroline.config.json`
  writable, which would mean rewriting a file somebody hand-edited and deciding what a restart means
  for it. The database path, bind address and port stay where they are.
- **It leaves the machine.** The name goes to the provider on every chat and planning call, a remote
  one included, so it is this spec's business rather than a UI detail. The payload preview shows the
  rendered preamble, which is the entire reason that screen exists: a preview that does not show the
  name is a preview that no longer proves what it claims to prove. It is built from the same
  rendering the provider is handed, not from a second one that could drift from it.
- **It is constrained rather than trusted.** It is free text from outside the program that ends up
  inside a system prompt, so it is bounded in length, a single line with control characters refused,
  and rendered as a quoted value in the preamble rather than concatenated into its instructions. A
  refused name is refused rather than silently rewritten, and the reason is said in a sentence.
- **An empty name is a supported state, not an error.** Somebody who would rather not be addressed by
  name says so by clearing the field, and the preamble then omits that sentence entirely rather than
  greeting nobody. Nothing about the person is sent in that case.
- **Nothing about the person goes over MCP, whatever the name is set to.** The preamble is a system
  prompt Caroline writes, and Caroline does not write an external client's, so the two facts in it have
  nowhere to go on that surface and are not sent. Stated rather than left as an accident of the
  transport, because it is a guarantee somebody may want to rely on: the MCP surface sends nothing about
  the person, only about the work.

## The item sent as context

The rail holds the details of one item beside the conversation, and that item goes to the provider on
every message sent while it is open (specs 07 and 08). A task's title and its notes are content: a
title here can carry a client's name, and notes are free text somebody wrote about that client's work.
So this is the same question the table above answers, asked of Caroline's own rows rather than of a
mailbox, and it is answered by the same `llmContent` level.

| Level | What goes about the selected item |
| --- | --- |
| `none` | Its kind and its id, and a line saying the policy withheld the rest |
| `metadata` | The above, plus its title, status, project, dates, estimate, who it waits on, its tags and its provenance: which source it came from and the link out |
| `snippet` | The above, plus the first `snippetChars` of its notes, marked as truncated where they were |
| `full` | The above, with its notes whole |

- **The level is not a display setting.** `metadata` sends a title, because spec 09's own table has
  always counted a subject or a title as metadata. What it does not send is the body-shaped field, and
  for a task and a project that field is `notes`.
- **A field is sent or it is absent.** Nothing is padded out with nulls, so the record of what was sent
  lists the fields that actually went and can be read as an audit rather than as a schema.
- **Nothing is fetched to build it.** The context is assembled from rows already on disk. The
  classifier's transient fetch exists because the classifier cannot do its job without a body; a
  conversation can, and a fetch per message would be a disclosure nobody asked for and a wait on every
  turn. This is also why the record of what was sent can keep the rendered text verbatim: there is
  nothing in it that `storeContent` has not already allowed onto the disk.
- **The same level governs the tool.** `get_task` returns a task's notes, so it is held to
  `llmContent` in the same way and by the same function. Two answers to whether a note may leave the
  machine would mean the policy is decoration. `list_projects` is the same case by another table: the
  body-shaped field of a project is `notes` as much as a task's is, so the one function answers for
  both. At `none` that holds for the rest of the item too: the tool answers with the kind and the id
  and says the policy withheld the rest, as the context does, because a level that withholds a title
  from the one cannot hand it over from the other.
- **The payload preview shows a real one.** The Settings screen renders the context for the same real
  item it already previews a classification call for, built by the same function a turn is built with.
  A preview of a screen's worth of policy that does not include the newest thing leaving the machine is
  no longer a preview.

## Credentials

- **Google**: OAuth desktop flow with PKCE, read-only scopes only (`gmail.readonly`,
  `calendar.readonly`), requested together so that consent is walked through once rather than
  once per feature. Client id and secret come from a Google Cloud project the user creates; the
  setup guide walks through it. Access and refresh tokens are stored in `google-tokens.json`
  with mode 0600 outside the repo, alongside the database, never in config or git. The redirect
  is the loopback address Caroline is already listening on. The authorisation code in the callback is
  neither logged nor echoed. Google's own `error` word is carried into the redirect so the settings
  screen can say what went wrong, which is safe because it comes from a fixed vocabulary and the
  screen maps it to a sentence of its own rather than rendering it.
- **GitHub**: a fine-grained personal access token, read-only, from the environment.
- **The login provider**: a client id in the configuration file and a client secret from the
  environment only, as `CAROLINE_AUTH_CLIENT_SECRET`, in the same three lists as every other
  configured secret so that one entry covers `GET /api/config` and every log line (spec 13). It is
  a second client, distinct from the Google client the Gmail and Calendar integration uses,
  because a login needs a registered `https` redirect and no mail scopes.
- **The browser session**: an opaque value held by the browser in a cookie and stored only as a
  hash in the database, so the file holds nothing that can be presented as a session. It is
  removed by `npm run delete-data` because it is in the database that command deletes.
- **LLM keys**: environment variables only. A key present in the config file is a startup
  error.
- **The tokens Caroline issues** to an MCP client (spec 12): in the database rather than in a
  file or the configuration, registered as runtime secrets through the same mechanism Google's
  access and refresh tokens use, so the guarantee below covers values that arrive after startup
  as well as configured ones, and removed by `npm run delete-data` because they are in the
  database it deletes. In the finished surface there is no static MCP token at all: a token
  Caroline issued through the authorisation code flow is the only credential it accepts. Spec 12's
  second slice has one for as long as it takes to build the surface before the authorisation
  server exists, and it follows the rule above rather than making an exception to it:
  `mcp.accessToken` comes from `CAROLINE_MCP_ACCESS_TOKEN` and from nowhere else, naming it in the
  config file is a startup error like any other secret, and spec 12's third slice deletes it.
- Secrets are redacted in API responses, logs and error messages. A test asserts that no
  configured secret value appears in any log line or HTTP response body.
- Redaction matches secret values literally, and runs on values before anything encodes
  them, because a secret rewritten by an encoder no longer matches itself: JSON escaping
  turns `tok"en` into `tok\"en`. Recognising a secret through its encodings does not
  terminate, so the encodings are handled by removing the places they occur rather than by
  matching more forms.
- Pre-encoding redaction covers every value in a log payload, and every field name, whatever
  the holding object's prototype. A class instance is not a plain object, but encoding walks
  its own properties just the same, so exempting it would leave a secret on the wire. The
  exceptions are the fields a log serialiser is about to shape, which redact their own
  output.
- No part of a request URL is logged or echoed in a response. Every byte of it is chosen by
  the caller, path as much as query string, so a secret can be smuggled into a log line in
  any encoding the caller likes and literal matching will not find it. Requests are
  identified in logs by method and by the route template they matched, which is written in
  this repository; a request matching no route contributes no URL bytes at all.

There is no encryption at rest beyond filesystem permissions. That is a deliberate choice
for a single-user local tool, and it is documented rather than implied: anyone with access
to the account has access to the data. Full-disk encryption is the right layer for that
concern.

Because those permissions are the whole of the protection at rest, they are set rather than
inherited. The data directory is created 0700, and the database and the SQLite sidecars beside it
(`-wal` and `-shm`, which hold the same page data) are 0600, applied at open and applied again to
a database that was there already, so an install created before this was written is tightened
rather than left as it was found. `google-tokens.json` has been 0600 since it was written, and the
database is the file with every task, note and stored body in it, so the two now agree. A default
umask leaves a newly created file readable by every account on the machine, which made "anyone
with access to the account" a claim about the wrong account. Two limits are stated rather than
implied: the mode is set on the files Caroline creates, and a directory the process did not create
is left alone, because `database.path` may point somewhere of the user's own and narrowing a
directory Caroline did not make is the overreach the deletion command already refuses.

A filesystem that cannot express these modes is a weaker posture and not a reason to refuse to
start. `CAROLINE_DB_PATH` pointing at a CIFS or exFAT mount, a container volume or a read-only
mount is an ordinary self-hosted arrangement, and `chmod` answers `EPERM`, `EACCES`, `ENOTSUP`,
`EOPNOTSUPP`, `EINVAL`, `ENOSYS` or `EROFS` there rather than succeeding; a database file owned by
another account answers `EPERM` too. Each of those is reported once on stderr, naming the paths and
the codes and saying that other accounts on the machine may be able to read the database, and then
Caroline starts. Anything else, `EIO` above all, means the storage itself is misbehaving and is
still fatal: these modes are defence in depth over a machine this spec already says has one user,
so failing to set them is worth saying and not worth refusing to run over.

## Network posture

- Binds to `127.0.0.1` by default. On loopback the socket is the boundary as far as other
  machines are concerned, and no credential is required of a caller there.
- **Every request is checked against the address it was addressed to, whatever the rest of the
  configuration says.** The `Host` header must name a loopback host, or the host of
  `server.publicUrl` where one is set. A missing `Host` is refused. This is the check the MCP
  endpoint has made since spec 12, applied to the rest of the API for the reason spec 12 gives for
  it: the socket being on loopback says where a
  connection came from and says nothing about who asked for it, and a name in DNS that somebody
  else controls can be pointed at `127.0.0.1`, at which point a page loaded from that name in the
  user's own browser is same-origin with the API and can read and write everything in it. The
  `Host` header is the one part of that the page cannot choose, because the browser writes it from
  the address bar. Deliberately not conditional on `authRequired`: the default configuration, a
  loopback bind with no login, is exactly the one the attack works against, so a check that only
  ran with a login configured would be a check on the installs that needed it least. It follows
  `isAcceptableOrigin`'s rule rather than a rule of its own, and the loopback set is the same one
  the startup guards use.
- **The hostname is compared and the port is not, and the loopback names are accepted whatever
  `server.publicUrl` says.** Both halves follow from what the check is for. A rebinding attacker
  forges DNS and cannot forge this header at all, so the hostname is the whole of the defence: the
  port adds nothing, and demanding the public URL's port refused every request behind the standard
  `proxy_set_header Host $host;`, which forwards a bare hostname. Admitting the loopback names
  costs nothing for the same reason, and refusing them cost a supported configuration outright,
  because `mcp.enabled` is constrained by the bind rather than by `server.publicUrl`: an install
  with both registers `POST /api/mcp`, that route requires a loopback `Host` of its own (spec 12,
  criterion 6), and the two rules together were unsatisfiable, so the endpoint answered 403 to
  everything. Exempting one route by its path would have fixed that with the path-based reasoning
  the encoded-path bypass came from, so the rule is uniform instead. What a routable install
  concedes by it is a remote caller sending `Host: localhost`, which then meets the session check
  and, on a write, the `Origin` check, exactly as any other request does.
- The refusal names `server.publicUrl`, because an operator who fronts Caroline with a proxy and
  has not set it meets this check on every request and the forwarded-header refusal below, which
  names the same setting, is never reached.
- **The `Origin` check runs on every non-`GET`/`HEAD` request too, whatever the configuration
  says.** Where a request carries an `Origin`, it must be an acceptable one (spec 13, "The
  acceptable origins"), and any loopback origin on any port is acceptable whatever
  `server.publicUrl` says, which is what keeps the Vite dev server working and what keeps the two
  `Origin` checks over `POST /api/mcp` satisfiable together. It was previously conditional on a login,
  and the gap that left was narrow and real: a JSON body forces a CORS preflight, so every route
  taking one was already protected, but a body-less `POST` is a simple request that no preflight
  covers, and `POST /api/tasks/:id/complete` and `POST /api/jobs/:name/run` are body-less. A page
  anywhere could fire one at a loopback install and have it succeed. Spec 13's argument for having
  no CSRF token is an argument from the acceptable-origin set, and that argument never depended on
  a login being configured.
- Binding to any other interface, declaring a `server.publicUrl`, or asking for a login
  explicitly requires authentication: a person proves who they are to an identity provider
  before anything answers (spec 13). It is enforced by one request-level check covering every
  registered route, and a configuration that would expose Caroline without a login refuses to
  start. There is no shared-secret alternative, and `server.accessToken` is gone: a secret in an
  environment variable identifies nobody and cannot be revoked without a restart.
- **The MCP endpoint is off by default (`mcp.enabled`, false), loopback only and enforced at
  startup: enabling it with `server.host` set to anything but loopback fails naming both keys**, and
  from spec 12's third slice the only
  credential it accepts is a token Caroline issued through its own authorisation code flow with
  PKCE. `Origin` is validated with a `403` and `Host` is validated against DNS rebinding,
  because loopback is not a boundary against other software on the machine and a page in the
  user's own browser can be made to POST to `127.0.0.1`. Spec 12 owns that surface. It is a
  second boundary rather than a relaxation of this one: nothing about it makes a routable bind
  more sensible than it was, and it is a second credential rather than a reopening of the one
  spec 13 removed: an MCP token is issued by Caroline, scoped to one client, and revocable
  without a restart, which is what `server.accessToken` never was.
- No inbound webhooks. All integration traffic is outbound polling (spec 02).
- Outbound destinations are limited to destinations the user named in the configuration:
  GitHub, Google, the configured LLM endpoint, and the identity provider's discovery document
  and token endpoint (spec 13). The identity provider belongs on that list for the same reason
  the LLM endpoint does: `auth.provider.issuer` is written by the user in the configuration file,
  exactly as `llm.baseUrl` is. One further destination is permitted, and only while a person is
  approving an MCP client: that client's metadata document. No telemetry, no analytics, no crash
  reporting.

  **That last one is a different kind of entry, not one more line of a list.** The named
  providers are destinations **the user** chose: GitHub because they made a token, Google
  because they walked a consent screen, the LLM endpoint and the identity provider because they
  named them in a file. A client metadata document is at a URL **a caller** supplied, which
  makes it the first outbound destination in Caroline's history that the user did not choose,
  and a request forgery surface. It is permitted because the alternative was the registration
  endpoint the MCP specification now deprecates, and it is permitted only under the guards spec
  12 states as criteria: `https` only; the address resolved, then checked to be a public one,
  then connected to as resolved, so that a DNS answer cannot smuggle a private address past the
  check and a second resolution cannot substitute one; a size cap enforced while reading; a time
  cap on the whole fetch; no redirect followed to another host; and no fetch at all outside an
  authorisation request somebody is at the keyboard for. Anything else of this kind has to make
  the same argument from scratch. This entry is not a precedent for allowing a caller to choose a
  destination.

## Configuration mechanics

Twelve-factor with a file for convenience: defaults in code, overridden by
`caroline.config.json`, overridden by environment variables. Secrets only ever from the
environment. The whole config is validated against a schema at startup, and an invalid
config fails fast with the offending path named.

Nothing in the file is written back from the UI. The one thing Settings writes is the name of the
person using Caroline, and that lives in the `settings` table rather than in the file, for the reason
given above: rewriting a file somebody hand-edited would mean deciding what a restart means for it.
Every value in the file therefore takes a restart, and the database path, bind address and port are
startup-only besides.

## Deletion

A documented single command removes everything: database, token file and cached content.
Nothing Caroline creates lives outside its data directory.

`npm run delete-data` is that command. It reads the same configuration the server reads, so it
deletes the files that Caroline would have been using and not the ones a default would have named.
Two decisions about it:

- **Deleting is not the default.** Run without `--yes` it lists what it would remove and removes
  nothing, because the destructive reading of a command somebody is trying out is the wrong one.
- **It deletes its own files, not a directory.** The database, the SQLite sidecars a crash leaves
  behind, the token file and the temporary sibling an interrupted token write leaves. Anything else
  in the data directory is left alone and named in the output, and the directory itself is removed
  only when it held one of those files and is empty afterwards: `database.path` may point somewhere
  of the user's own, and a command that deleted a directory it did not create would be a worse
  failure than one that leaves an empty folder. A directory carrying one of those names is not one of
  those files, a symbolic link is removed as a link rather than followed, and a file that will not go
  is reported with what the filesystem said rather than thrown as a stack trace over a deletion that
  is already half done.

## Non-goals

- Per-item or per-sender privacy rules, redaction, or PII detection in v1. The policy is
  global. Selective rules are a plausible v2 and would get their own spec.
- Encryption at rest, secret managers, or OS keychain integration.
- Audit logging beyond `job_runs`, `classifications` and `llm_calls`, with one named exception:
  the MCP surface records a row per derived session and a row per tool call (spec 12), because
  chat's disclosures are covered by sitting under an `llm_calls` row and a turn, and over MCP
  there is no `llm_calls` row at all. Writes there are covered by the change records; reads would
  otherwise be covered by nothing, and a client could read the whole board and leave no trace.
  Those rows hold the tool, an arguments digest, whether the call was held, the level and policy
  version in force and a count of items answered, and never the answered text.
- Any multi-user access control.
- **Rate limiting, on `/api/chat`, on the job triggers or anywhere else.** Considered and declined
  rather than overlooked, which is why it is written here. What a limiter would bound is cost and
  availability, not access: every surface that spends money or does work sits behind the boundary
  above, so the caller is either the one person this instance belongs to or somebody who has
  already got past a login, and neither is a stranger a limiter would turn away. What it would add
  is a production dependency and a configuration surface (a window, a burst, a per-route override,
  an answer for what a limited request looks like to the client) for a threat model that is one
  person hammering their own machine. The bounds that do exist are the ones with a reason of their
  own: `chat.maxToolCalls` bounds a turn, the scheduler runs one job at a time and holds a failing
  one back, and the provider's own quota is the ceiling on spend. If Caroline ever grows a surface
  an unauthenticated caller can reach, this decision is the first one to revisit, and it should be
  revisited as a decision rather than patched around.

## Acceptance criteria

1. With `llmContent: "metadata"`, no body text appears in any provider request payload,
   asserted by inspecting the built request rather than by inspecting the prompt template.
2. With `llmContent: "full"` and a remote provider and the allow flag false, startup fails
   with a message naming both settings.
3. With `storeContent: "none"`, no `content` column is ever written, for any connector.
4. Lowering `storeContent` purges previously stored content above the new level and reports
   the count.
5. Content older than `retainContentDays` is purged while its source row and task survive.
6. No secret value appears in any log line, API response or error message.
7. Binding to a non-loopback address without authentication configured fails at startup, naming
   the settings involved. The claim is the one this criterion has always made, that a
   non-loopback bind must not be unprotected; what satisfies it is a login rather than a shared
   token (spec 13).
8. `GET /api/config` returns the full effective configuration with every secret field
   redacted.
9. The settings screen can show the exact payload that would be sent for a given real item
   under the current policy.
10. The documented deletion command leaves no Caroline-created file on disk.
11. The name of the person using Caroline reaches the provider in the shared preamble, asserted
    against the built request for both chat and the planner, and the payload preview shows that same
    rendered preamble.
12. A name containing a line break or any other control character is refused with a message saying
    why, a name longer than the cap is refused, and an empty name is accepted and sends nothing about
    the person.
13. With `llmContent: "metadata"`, a selected task's notes appear in no provider request payload,
    neither in the item context nor in a `get_task` result, while its title does, and a project's notes
    go the same way through `list_projects`, being the same field of the same shape. With
    `llmContent: "none"` nothing but an item's kind and id appears, on every path alike: the item
    context, each of spec 07's read tools, each of its write tools and the descriptions and refusals
    they answer with, and the turns of the conversation replayed as context. Every one of them says the
    policy withheld the rest rather than answering with a title, a name or a rationale. With
    `llmContent: "snippet"` notes are truncated to `snippetChars` and said to be truncated. Asserted
    against the built request.
14. The payload preview shows the item context for a real item, rendered by the same function that
    builds a turn's, so the screen cannot drift from what leaves the machine.
15. The payloads published in `docs/content-policy.md` are generated by the functions that build the
    real one, one item at each of the four levels of `llmContent`, and a test fails when the committed
    document and those functions disagree. Documentation of what leaves the machine is a promise about
    somebody's mail, so it is checked rather than reviewed: a documented payload that has drifted from
    the code is worse than no example. None of them carries an address or anything shaped like a key.
    The same document's block of privacy defaults is generated from the schema that declares them and
    checked the same way, so no default in it is a second copy anybody maintains.
    The published payloads cover the MCP tool response at those same four levels, by the same
    generation and the same drift test: this criterion is extended to that boundary rather than joined
    by a second one, because the reasoning applies to it at least as strongly, and one criterion
    covering both boundaries cannot drift apart the way two would.

Authentication (spec 13) adds the following, appended rather than renumbered because criterion
numbers are cited by the code and the suite.

16. With authentication required, no route under `/api` other than the three public auth routes is
    served to a request carrying no valid session, asserted over the registered route list rather
    than route by route.
17. No value belonging to the login flow or to a session appears in any log line or response body,
    on any path: neither the session value, nor the authorization code, nor the identity token, nor
    the provider's client secret.

The MCP surface adds the following, appended for the same reason. It had a third, a request-level
check on `server.accessToken`, written while authentication was still an unwritten milestone: both
were drafted against the same next free number, and authentication landed first, so 16 and 17 above
are its and these take the numbers after them. That third criterion is not among them. Spec 13
criteria 7 and 8 answer the same question differently and better, by removing the token outright and
putting a session check under `/api` in its place, so there is nothing left for it to assert. It is
dropped rather than marked superseded, which the convention above permits only because it was never
merged: no code and no test cites it, and citation is the whole reason the convention exists.

18. With the MCP server enabled, `llmContent: "full"` and `allowFullContentToRemoteProvider: false`,
    startup fails naming all three settings, whatever `llm.provider` is set to, `ollama` included.
19. The only outbound destinations the process attempts are the configured providers and, during an
    authorisation request for an MCP client, that client's metadata document over `https`, to an address
    resolved and checked to be public before anything connects to it and connected to as resolved, under
    a size cap enforced while reading and a time cap on the whole fetch, following no redirect to another
    host. No such fetch happens at startup, on a schedule or during a token request. Asserted over the
    whole process rather than over the module that makes the fetch, so that a later addition cannot slip
    in beside it.

The security review of 2026-08-21 adds the following, appended for the reason the earlier blocks
were: the numbers are cited by the code and by the suite.

20. A request whose path reaches a route under `/api` is held to criterion 16 however that path was
    spelled, not only in the canonical spelling: the exemption is decided by the route template the
    router matched rather than by the request's own URL. Asserted with percent-encoded paths
    (`/%61pi/tasks` and the rest) over read and write routes alike, because the criterion 16 test
    walks canonical route paths and those are exactly the paths on which the two readings agree. A
    request that matched no route at all is decided by its decoded path instead, and one addressing
    `/api` is refused, while a path that cannot be decoded does not throw out of the check. That
    branch is asserted on the predicate directly and, over HTTP, on the two configurations that
    reach it: a checkout with no built SPA, and a method `@fastify/static` does not register. With
    the built SPA present its `/*` route matches every unmatched `GET`, so such a request carries
    `/*` as its template, is exempt from the session check, and is answered by the API's own JSON
    404 of criterion 26 instead. An unauthenticated caller can therefore distinguish an API route
    that exists (401) from one that does not (404). That is accepted rather than overlooked: the
    route list is published in this repository, so it is no oracle, and a fallback whose refusal
    does not depend on which routes a configuration happens to register is worth more than hiding
    it.
21. Every request, whatever `authRequired` is, is refused with a `403` unless its `Host` header
    names an address this install answers to: a loopback name, or the host of `server.publicUrl`
    where one is set. The hostname is what is compared, not the port, and the refusal names
    `server.publicUrl`. Both sides of that comparison have the root label's trailing dot removed,
    so the fully qualified spelling of a name this install answers to is accepted in `Host` and in
    `Origin` alike, and a second dot is not. A request carrying no `Host` is refused. Asserted on
    the default configuration, which is the one the check exists for, as well as on an exposed one,
    including an exposed one whose public URL names a port and one whose public URL is itself
    loopback.
22. The `Origin` check of spec 13 criterion 24 runs whatever `authRequired` is, and a body-less
    `POST` carrying a cross-site `Origin` is refused with a `403` on a loopback install with no
    login. Any loopback origin on any port is still accepted whatever `server.publicUrl` says, so
    the dev server keeps working, and that is asserted rather than assumed.
23. The data directory Caroline creates is 0700, and the database and its `-wal` and `-shm`
    sidecars are 0600, including on a database that already existed with a wider mode. An
    in-memory or URI database path touches the filesystem not at all, and a directory the process
    did not create is left as it was found.
24. The classifier's system prompt carries the same data-not-instruction sentence the chat context
    carries, by importing it rather than restating it, and it reaches the provider on the call the
    classifier makes. Asserted against the built request, as criterion 1 is, and against the shared
    constant, because the point is that the wording is shared and cannot drift.
25. A `chmod` that fails because the filesystem or the file cannot carry the mode does not stop
    Caroline starting: the codes listed under "Data at rest" above are reported once on stderr and
    the database opens, and any other code is still thrown. Asserted per code, with `chmodSync`
    mocked, because no POSIX filesystem can be made to refuse a `chmod` from the account owning
    the file and the behaviour under test is what this does with the error rather than which mount
    produces it.
26. An unmatched path that addresses the API is answered with the API's JSON 404 however it was
    spelled, including percent-encoded (`/%61pi/no-such-route`), rather than with the SPA shell,
    and an unmatched path that does not address the API still gets the shell. Criterion 20's
    reading of a request's own URL, applied to the one other place that read one. Asserted with the
    built SPA present, since with no shell to serve both answers are already a 404.

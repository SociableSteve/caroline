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
- **LLM keys**: environment variables only. A key present in the config file is a startup
  error.
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

## Network posture

- Binds to `127.0.0.1` by default. Binding to any other interface requires setting an
  access token, enforced at startup, because the UI has no login.
- No inbound webhooks. All integration traffic is outbound polling (spec 02).
- Outbound destinations are limited to the configured providers: GitHub, Google and the
  configured LLM endpoint. No telemetry, no analytics, no crash reporting.

## Configuration mechanics

Twelve-factor with a file for convenience: defaults in code, overridden by
`caroline.config.json`, overridden by environment variables. Secrets only ever from the
environment. The whole config is validated against a schema at startup, and an invalid
config fails fast with the offending path named.

Config editable from Settings is written back to the file. The database path, bind address
and port are startup-only and not editable at runtime.

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
- Audit logging beyond `job_runs`, `classifications` and `llm_calls`.
- Any multi-user access control.

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
7. Binding to a non-loopback address without an access token fails at startup.
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

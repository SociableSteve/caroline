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
| `metadata` | Sender or author, recipients, subject or title, timestamps, labels, PR stats. No body |
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

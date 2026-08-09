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
  what the connector fetched.
- `llmContent: "full"` with a remote provider (Anthropic or OpenAI) requires
  `allowFullContentToRemoteProvider: true`. Without it, startup fails with an explanation
  rather than quietly downgrading. With Ollama, `isLocal` is true and the guard does not
  apply.
- Changing `storeContent` to a lower level purges content already stored above that level
  on the next run, and says how many rows it cleared.
- `retainContentDays` purges stored `content` older than the window on a daily job. Source
  rows, tasks and metadata survive; only the body text is dropped.

### Defaults

`llmContent: "snippet"`, `storeContent: "metadata"`,
`allowFullContentToRemoteProvider: false`. Sensible for a work mailbox: enough for the
classifier to work, no bodies at rest, nothing full-text sent to a third party without an
explicit decision.

Every settings control that changes exposure states its consequence in plain language, not
just its name. The UI shows, for the current configuration, exactly what a classification
call would contain, using a real item, before it is used.

## Credentials

- **Google**: OAuth desktop flow, read-only scopes only (`gmail.readonly`,
  `calendar.readonly`). Client id and secret come from a Google Cloud project the user
  creates; the setup guide walks through it. Access and refresh tokens are stored in a
  token file with mode 0600 outside the repo, alongside the database, never in config or
  git.
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
- Query strings are never logged and never echoed in a response. They are the only part of
  a request whose bytes a caller chooses freely, and nothing here puts anything in one
  worth keeping. Requests are identified in logs by method and path.

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

# Caroline specs

Caroline is a single-user, self-hosted assistant that pulls work from GitHub, Gmail and
Google Calendar into a lightweight GTD system, keeps it sorted with an LLM, and proposes a
daily plan sized to your actual free time.

These specs are the source of truth. Code is the byproduct. If an implementation and a
spec disagree, one of them is a defect: decide which, fix that one.

## Reading order

| Spec | Covers |
| --- | --- |
| [00-overview.md](00-overview.md) | Problem, architecture, runtime shape, delivery order |
| [01-task-model.md](01-task-model.md) | Statuses, tasks, projects, sources, the database schema |
| [02-ingestion.md](02-ingestion.md) | Sync engine and the GitHub, Gmail and Calendar connectors |
| [03-llm-provider.md](03-llm-provider.md) | Provider abstraction over Anthropic, OpenAI and Ollama |
| [04-classification.md](04-classification.md) | Hourly inbox auto-sort |
| [05-daily-plan.md](05-daily-plan.md) | Daily planning against calendar capacity |
| [06-scheduler.md](06-scheduler.md) | Job scheduling, missed runs, run history |
| [07-chat.md](07-chat.md) | Conversational interface and its tool surface |
| [08-api-and-ui.md](08-api-and-ui.md) | HTTP API and the browser UI |
| [09-config-and-security.md](09-config-and-security.md) | Configuration, credentials, data-exposure posture |
| [10-design-system.md](10-design-system.md) | The scales, primitives and appearance rules the surfaces share |
| [11-public-site.md](11-public-site.md) | The site that publishes these documents, and how it stays one copy of them |
| [12-mcp-server.md](12-mcp-server.md) | The tool surface for an external assistant, and how it is authorised |
| [13-authentication.md](13-authentication.md) | Who may reach Caroline over a network, and how they prove it |
| [14-operational-logging.md](14-operational-logging.md) | What the process keeps about what it did, how much of it, and how verbose it gets |

## Conventions

Every spec states its non-goals explicitly. Acceptance criteria are written so a test can
assert them, and each one is the contract a test must cover. Tests come before
implementation.

**Acceptance criteria are appended, never renumbered.** The code and the suite cite them by
number, in comments and in test names, so inserting one in the middle, or renumbering in any other
way, silently repoints every citation after it at a criterion it was not written about. A new
criterion therefore goes at the end with the next free number, even where it would read better
beside the one it belongs with, and a criterion that is no longer wanted is left in place and said
to be superseded rather than removed. Each spec that has grown says so above the criteria it
appended, which is the record of which milestone added what. A criterion may be extended in place,
because that keeps its number pointing at the same contract; what may not move is the numbering.

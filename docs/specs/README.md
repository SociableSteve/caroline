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
| [13-authentication.md](13-authentication.md) | Who may reach Caroline over a network, and how they prove it |

## Conventions

Every spec states its non-goals explicitly. Acceptance criteria are written so a test can
assert them, and each one is the contract a test must cover. Tests come before
implementation.

Acceptance criteria are appended, never renumbered. Code comments and test names cite them by
number, so inserting one in the middle would silently repoint every citation after it at the wrong
rule. A new criterion goes at the end with the next number even where it would read better
somewhere else, under a line saying what added it.

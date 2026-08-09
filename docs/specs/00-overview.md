# 00. System overview

## Problem

Work arrives from several places at once: pull requests waiting on review, email that
implies a commitment, meetings that generate follow-ups. None of those systems knows about
the others, and none of them knows how much time there is in the day. The result is a
triage tax paid several times daily and a plan that ignores the calendar.

Caroline collects those inputs into one lightweight GTD system, uses an LLM to keep the
inbox sorted, and proposes a daily plan that fits the free time actually available.

## Shape

A single-user, self-hosted Node process. One deployable: Fastify serves the JSON API, the
built React SPA and the scheduler in the same process, against a local SQLite file. No
multi-tenancy, no shared server, no account system.

```
                +-----------------------------------------------+
  GitHub  --->  |  connectors  ->  sync engine  ->  SQLite       |
  Gmail   --->  |                                    ^     ^     |
  GCal    --->  |                                    |     |     |
                |  scheduler --> classifier ---------+     |     |
                |     |     \--> daily planner ------+     |     |
                |     |                                    |     |
                |  LLM provider (Anthropic|OpenAI|Ollama)   |     |
                |     ^                                     |     |
                |     +----- chat (tool use) ---------------+     |
                |                                                 |
                |  Fastify HTTP API  <--->  React SPA             |
                +-----------------------------------------------+
```

### Stack

- TypeScript throughout, ESM, Node 24 LTS or later.
- Fastify for HTTP, serving the API and static SPA assets.
- React SPA, built with Vite.
- SQLite via the built-in `node:sqlite`, one file on disk. No native module, so installing
  Caroline never needs a compiler. This is what sets the Node 24 floor.
- Vitest as the single test runner for server and client.

### Principles

- **The local database is the source of truth for task state.** External systems are
  inputs. Caroline never depends on being able to write to them.
- **Read-only ingestion in v1.** No labels applied, no PR comments, no calendar writes.
  See non-goals below.
- **A human decision always beats a machine one.** Any status a person set is never
  overwritten by the classifier.
- **Nothing leaves the machine unless configured to.** Every outbound payload to an LLM
  provider is governed by an explicit content policy (spec 09).

## Delivery order

1. Task model and persistence (spec 01).
2. HTTP API and a minimal board UI over manually created tasks (spec 08).
3. Sync engine plus the GitHub connector (spec 02): the first real input.
4. LLM provider abstraction (spec 03).
5. Gmail connector plus hourly classification (specs 02, 04, 06).
6. Calendar connector and the daily plan (specs 02, 05).
7. Chat (spec 07).

Each step is shippable and useful on its own. Nothing after step 2 is required for the
system to be worth running.

## Non-goals

- Writing back to GitHub, Gmail or Calendar. Caroline reads. A later version may apply
  Gmail labels, and the ingestion spec keeps that door open, but v1 does not.
- Multi-user or hosted operation. No tenancy, no per-user OAuth brokering.
- Mobile or native clients.
- Full GTD orthodoxy: no contexts, no weekly-review workflow, no tickler file beyond a
  deferred date on a task.
- Time tracking, or any claim about what you actually did with the day.

## Acceptance criteria

1. `npm start` on a clean checkout with no credentials configured starts the server, serves
   the UI, and reports every integration as "not configured" rather than failing.
2. The process runs with no network access to any external system and remains usable for
   manually created tasks.
3. Deleting the SQLite file and restarting produces a working empty system; a subsequent
   sync repopulates all externally sourced items.

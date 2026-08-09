# Caroline

A single-user, self-hosted GTD system. It collects work from GitHub, Gmail and Calendar,
keeps the inbox sorted with an LLM, and proposes a daily plan that fits the free time
actually available.

See [docs/specs](docs/specs/README.md) for what it does and [docs/plan.md](docs/plan.md)
for the order it gets built in. This is milestone M2: a usable manual GTD app. Tasks and
projects over an HTTP API, a keyboard-operable board, quick capture, a projects view and a
dashboard. No integrations and no LLM yet, so nothing arrives on its own: what is in it is
what you put in it.

## Running it

Node 24 or later, which is where the built-in `node:sqlite` stops being experimental (Node
24.2.0). There is no native module to compile.

```sh
npm install
npm run build
npm start
```

With nothing configured, the server starts, serves the UI and reports every integration as
"not configured". No credentials are needed to run it. The SQLite database is created at
`./data/caroline.db` on first run and migrated on every start.

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
| `CAROLINE_ACCESS_TOKEN`                                                | Required to bind to anything other than loopback          |
| `CAROLINE_DB_PATH`                                                     | SQLite file location                                      |
| `CAROLINE_LLM_PROVIDER`, `CAROLINE_LLM_MODEL`, `CAROLINE_LLM_BASE_URL` | LLM selection                                             |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`                                  | LLM key for the selected provider                         |
| `GITHUB_TOKEN`                                                         | Fine-grained personal access token, read-only             |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`                             | OAuth desktop client from your Google Cloud project       |
| `CAROLINE_LOG_LEVEL`                                                   | Pino log level. Default `info`                            |

`tasks.waitingStaleDays` sets how long something may sit in Waiting for before it is called
out as gone quiet, in the column and on the dashboard. Seven days by default, per
[spec 02](docs/specs/02-ingestion.md).

### Using the board

The board is operable from the keyboard alone: arrow keys or `h j k l` to move between
cards and columns, `1` to `6` to move the focused card to that column, `d` to complete it,
and `c` to capture something new from anywhere. Dragging a card between columns does the
same thing as the digit. Either way the change is recorded as yours, and the classifier will
not later overrule it.

### What leaves the machine

`privacy.llmContent` governs how much of an item is sent to the LLM provider, and
`privacy.storeContent` how much is kept on disk. They are set independently and default to
`snippet` and `metadata`. Sending complete bodies to a hosted provider additionally
requires `allowFullContentToRemoteProvider`, and startup fails if it is not set. See
[spec 09](docs/specs/09-config-and-security.md).

Caroline binds to `127.0.0.1` and has no login. Binding anywhere else requires an access
token, enforced at startup.

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

## Licence

MIT.

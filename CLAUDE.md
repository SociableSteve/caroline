# CLAUDE.md

The conventions for working on Caroline live in [AGENTS.md](AGENTS.md), which is the one
authoritative copy: most tools read it where it is rather than each one getting its own copy to
drift. Copilot Chat and Visual Studio are the exception, since they read
`.github/copilot-instructions.md` and nothing else, so that path holds a generated copy of
`AGENTS.md` which `npm run docs:copilot` writes and `test/docs/copilot-instructions.test.ts` keeps
identical.

@AGENTS.md

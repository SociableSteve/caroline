# Looking at Caroline

Three scripts for driving the built client in a browser and looking at the result. None of them is
part of the suite, and none of them runs in CI.

They exist because of what M9 found. Eight defects on that milestone were invisible in the source
and obvious in a render: a pull request id clipped in a 15rem column and dragging its label column
down with it, a sentence escaping its panel and landing over the one beside it, a plan row squeezed
to a word a line, a dead gap under a band. Not one of them could have been caught by the suite,
because jsdom lays nothing out. `styles.test.ts` can tell you a declaration exists; it cannot tell
you the result fits.

## Using them

```bash
npm run build                 # the scripts drive the built client, not the dev server
export CAROLINE_CONFIG=/tmp/caroline-demo/config.json  # write it first, below: both read it
npm run demo:seed             # writes a seeded day into /tmp/caroline-demo/demo.db
npm start                     # pointed at that database, on a port of its own
npm run demo:shoot            # writes PNGs of the five surfaces and the rail to /tmp/caroline-demo/shots
npm run demo:shoot -- --docs  # rewrites the pictures the documentation carries, in docs/images
npm run demo:measure          # reports whether the board's columns really bound and scroll
```

Three settings are the whole of what that file needs. The port is the one `shoot.mjs` looks for, and the
provider is named so that the rail is not photographed in its read-only state: with none configured, chat
says it cannot answer, and the banner saying so displaces the sentence about the content policy that
`docs/using.md` quotes out of that picture. Ollama needs no key, and nothing calls a model during a shoot.

```json
{
  "database": { "path": "/tmp/caroline-demo/demo.db" },
  "server": { "port": 5207 },
  "llm": { "provider": "ollama", "model": "llama3.1", "supportsTools": true }
}
```

`CAROLINE_CONFIG` is optional for the seed and it falls back to the schema's defaults, but give both the
same file. The day it seeds is fitted against a capacity the server computes: the working window, the
meetings you accepted and the reserve decide what fits and what is left over, so a plan seeded under one
configuration and served under another can contradict the bar drawn beside it. That has happened: the
plan warned that no capacity was left after the reserve above a bar showing more than two hours free, and
a picture of the pair is what the documentation carried.

The seed also refuses to run on a day `planning.workingDays` does not include, and says so. There is no
capacity on such a day, so the dashboard shows "Today is not a working day" where `docs/using.md` reads
the arithmetic out of the picture, and a reshoot at a weekend would commit that over a plan with four
entries and two warnings with the whole suite green. Seed and shoot on a working day, or say in the
config that this one is.

The day's plan is not written out in `seed.ts` either: it is drawn by `runPlanning`, the same function
the scheduler and **Regenerate** call, from a scripted provider standing in for a model so that nothing
reaches a network. So the entries, their order, the review entry spec 05 criterion 7 promises, the chase
nudges, the overflow and every warning are the application's output rather than somebody's picture of
it. Written by hand they drifted, and the published dashboard ended up showing a plan with no review in
it, a warning about the reserve that no line of Caroline can emit, none of the unverified-capacity
warning a real run does emit, and a chase list holding an item the chase rule would not have selected.
The seed then refuses if that plan comes out without an overflow, a warning, a review entry or a chase
nudge, since each of those is a panel `docs/using.md` reads out of a picture no test can open. It prints
the plan it drew, which is the thing to read before committing a reshoot.

Each run starts by deleting the database file. Nothing in the seed is an upsert on a stable key, so a
second run against the same file used to deal six projects and two of every card, and it is what makes
a refusal above cost nothing.

`--docs` is the one of them whose output is committed: three shots, in both palettes, into
`docs/images`, which is where `docs/using.md` and the site take them from. Those images are published,
which is why they are generated rather than captured, and why the seeded day names one invented owner
throughout rather than a real organisation: the items are invented, and a picture of them on a public
page should read that way rather than leaving a stranger to wonder whose pull requests they are.
`example-org` is invented and not reserved, since GitHub reserves nothing of the sort, so the links are
what the discipline actually rests on: the seed writes every URL on `github.invalid`, a host RFC 2606
keeps unresolvable for good. `test/docs/screenshots.test.ts` holds all of that. Regenerate the images
whenever a surface in one of them changes, from the same seeded database, and the diff is the change.

`seed.ts` never touches the configured database. It writes to `SEED_DB`, defaulting to a path
under `/tmp`, and prints where it went, whatever the config file says about `database.path`. Point that
file's `database.path` at the seeded path and run the server against it.

`shoot.mjs` and `measure.mjs` speak the DevTools protocol directly over Node's global `WebSocket`,
so neither Playwright nor Puppeteer is a dependency. They find a browser via `CHROME_PATH`, then
the usual system locations, then any Chromium a previous `playwright install` left in the cache. If
there is none, they say so and tell you how to get one.

Two things worth knowing if you change them. Chrome's own `--screenshot` with
`--virtual-time-budget` hangs on this client, because it holds an SSE subscription to the change
feed open and ticks a one-minute interval, so virtual time never settles: driving the protocol and
deciding for ourselves when the page has had long enough is the way round it. And the seed writes
job runs that the scheduler will overwrite within a minute or two of the server starting, so shoot
early if the failed purge run is what you are there to look at.

## What to look at

The seed puts the states that are easy to get wrong on the screen at once: a wait past the
staleness threshold beside one that is not, a task overdue and another due today, a pull request
whose author has pushed since you reviewed it, a proposal below the confidence threshold with its
reasoning, a stalled project, a plan with an overflow, a review entry and two warnings, and a job
that failed with an error long enough to test the row it sits in.

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
npm run demo:seed             # writes a seeded day into /tmp/caroline-demo/demo.db
CAROLINE_CONFIG=... npm start # pointed at that database, on a port of its own
npm run demo:shoot            # writes PNGs of the five surfaces and the rail to /tmp/caroline-demo/shots
npm run demo:shoot -- --docs  # rewrites the pictures the documentation carries, in docs/images
npm run demo:measure          # reports whether the board's columns really bound and scroll
```

`--docs` is the one of them whose output is committed: three shots, in both palettes, into
`docs/images`, which is where `docs/using.md` and the site take them from. Those images are published,
which is why they are generated rather than captured, and why the seeded day names the reserved
`example-org` rather than a real organisation: the items are invented, and a picture of them on a public
page should read that way rather than leaving a stranger to wonder whose pull requests they are.
`test/docs/screenshots.test.ts` holds both halves of that. Regenerate them whenever a surface in one of
them changes, from the same seeded database, and the diff is the change.

`seed.ts` never touches the configured database. It writes to `SEED_DB`, defaulting to a path
under `/tmp`, and prints where it went. Point a config file's `database.path` at that and run the
server against it.

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
reasoning, a stalled project, a plan with an overflow and a warning, and a job that failed with an
error long enough to test the row it sits in.

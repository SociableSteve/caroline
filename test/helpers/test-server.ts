import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { loadConfig } from '../../src/config/load.js'
import type { Config } from '../../src/config/schema.js'
import type { Database } from '../../src/db/connection.js'
import { buildServer } from '../../src/server/app.js'
import { createChangeFeed, type ChangeEvent, type ChangeFeed } from '../../src/server/changes.js'
import { buildJobs } from '../../src/jobs/registry.js'
import type { CarolineJobs } from '../../src/jobs/registry.js'
import { createScheduler, type JobStep } from '../../src/jobs/scheduler.js'
import type { GoogleAuth } from '../../src/connectors/google/auth.js'
import { migratedDatabase } from './temp-database.js'

/**
 * A `webRoot` that provably does not exist, for a server a test wants with no built SPA to serve:
 * `buildServer`'s `existsSync(webRoot)` check decides whether `@fastify/static` registers its own
 * wildcard route for everything under `/`, and relying on the real build output being incidentally
 * absent makes a test's outcome depend on whatever `npm run build` last did in this checkout rather
 * than on the test itself. Shared rather than restated, since test/server/logging.test.ts and
 * test/auth/gate.test.ts both build a server with the same requirement.
 */
export const NO_BUILT_WEB_ROOT = '/dev/null/no-such-caroline-web-build'

/**
 * A directory of this file's own, for everything the configuration derives from the database path.
 *
 * The database these tests actually run against is a temporary one, but the config's own
 * `database.path` was left to default, and `googleTokenPath` derives the Google token file from
 * it. On a machine where Caroline is really used that resolved to the real `data/google-tokens.json`,
 * so the assertion that a clean checkout is not connected read the developer's live connection and
 * failed, and a test that completed the OAuth flow wrote a token into the real data directory.
 * A test suite has no business reading or writing there.
 */
const configDirectory = mkdtempSync(join(tmpdir(), 'caroline-config-'))

afterAll(() => {
  rmSync(configDirectory, { recursive: true, force: true })
})

/**
 * A clean checkout with no credentials, which is what the API tests care about.
 *
 * The timezone is pinned rather than left to default. `jobs.timezone` defaults to whatever the
 * machine thinks it is in, which is the right answer for a single-user tool and the wrong one
 * for a test suite: anything that resolves a local working window or a calendar day then passes
 * in one zone and fails in another, and CI does not run where the author does. Europe/London
 * rather than UTC on purpose, so that a test written across a British Summer Time offset
 * exercises an offset at all.
 *
 * The database path is pinned for the same class of reason: a default that happens to be right on
 * a clean checkout and wrong on a working machine is not a default a test suite can use.
 */
export const testConfig = loadConfig({
  file: {
    database: { path: join(configDirectory, 'caroline.db') },
    jobs: { timezone: 'Europe/London' },
  },
  env: {} as NodeJS.ProcessEnv,
})

/** Every write the API makes is stamped with this, so assertions can name the moment. */
export const REQUEST_TIME = Date.UTC(2026, 5, 1, 9, 0, 0)

export interface TestServer {
  readonly app: FastifyInstance
  readonly database: Database
  readonly changes: ChangeFeed
  /** Everything the routes published, in order. */
  readonly published: ChangeEvent[]
  /** The jobs the routes were given, so a test can ask the scheduler what it is doing. */
  readonly jobs: CarolineJobs
}

/** Anything that would have reached the network fails loudly instead. */
const refuseNetwork: typeof globalThis.fetch = (input) => {
  throw new Error(`A test tried to reach ${String(input)}`)
}

const openApps: FastifyInstance[] = []

afterEach(async () => {
  for (const app of openApps.splice(0)) await app.close()
})

/**
 * A real server over a real migrated SQLite file, driven with `inject`. Nothing is mocked:
 * the routes are worth testing precisely where they meet the database.
 */
export interface TestServerOptions {
  /**
   * Jobs the routes should use instead of the set built from the config. Supply `database` with it:
   * jobs hold the database they were built with, and leaving this one to its default would have the
   * routes reading a different file from the jobs.
   */
  readonly jobs?: CarolineJobs
  /** An already-migrated database to serve, for a test that seeded one before the server existed. */
  readonly database?: Database
  /**
   * The `fetch` the connectors and the model adapters are built with. Nothing in the suite reaches
   * a network, and a route that would have is a test failure rather than a slow test.
   */
  readonly fetch?: typeof globalThis.fetch
  /**
   * Steps to run in place of the real ones, for a test about the route rather than about the job.
   * The replacement scheduler registers no schedules, so these run on demand and never on a tick.
   */
  readonly steps?: readonly JobStep[]
  /** The Google connection the integration routes should see. */
  readonly google?: GoogleAuth
  /**
   * The config to build the server with, for a test of spec 13 that needs `authRequired: true`.
   * Defaults to `testConfig`, the loopback install every other test in the suite uses.
   */
  readonly config?: Config
  /** The `fetch` the auth service is built with, for a test that stubs OIDC discovery and the
   * token endpoint. Defaults to `refuseNetwork`, like every other fetch this helper builds. */
  readonly authFetch?: typeof globalThis.fetch
  /** Replaces the MCP authorisation server's client metadata fetch, for a test that drives
   * `GET /api/mcp/authorize` without reaching a real network. Undefined means the real one,
   * which every such test therefore has to stub explicitly. */
  readonly mcpClientMetadataFetch?: Parameters<typeof buildServer>[0]['mcpClientMetadataFetch']
}

export async function testServer({
  jobs,
  database = migratedDatabase(),
  fetch,
  steps,
  google,
  config = testConfig,
  authFetch,
  mcpClientMetadataFetch,
}: TestServerOptions = {}): Promise<TestServer> {
  const changes = createChangeFeed()
  const published: ChangeEvent[] = []
  changes.subscribe((event) => published.push(event))

  const built =
    jobs ??
    buildJobs({
      database,
      config,
      changes,
      now: () => REQUEST_TIME,
      fetch: fetch ?? refuseNetwork,
    })

  // The steps are replaced by rebuilding the scheduler around them rather than by reaching into
  // one, so the overlap guard, the recording and the announcements under test are the real ones.
  // No schedules are registered: nothing here fires on a tick, and every run is a manual one.
  const withSteps: CarolineJobs =
    steps === undefined
      ? built
      : {
          ...built,
          scheduler: createScheduler({
            database,
            steps,
            schedules: [],
            timeZone: config.jobs.timezone,
            backoffBaseMs: 60_000,
            backoffCeilingMs: 3_600_000,
            startupStaggerMs: 0,
            now: () => REQUEST_TIME,
            changes,
          }),
        }

  const finalJobs: CarolineJobs = google === undefined ? withSteps : { ...withSteps, google }

  const app = await buildServer({
    config,
    database,
    changes,
    now: () => REQUEST_TIME,
    jobs: finalJobs,
    authFetch: authFetch ?? refuseNetwork,
    ...(mcpClientMetadataFetch === undefined ? {} : { mcpClientMetadataFetch }),
    webRoot: NO_BUILT_WEB_ROOT,
  })
  openApps.push(app)

  return { app, database, changes, published, jobs: finalJobs }
}

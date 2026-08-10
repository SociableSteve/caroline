import { afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { loadConfig } from '../../src/config/load.js'
import type { Database } from '../../src/db/connection.js'
import { buildServer } from '../../src/server/app.js'
import { createChangeFeed, type ChangeEvent, type ChangeFeed } from '../../src/server/changes.js'
import { buildJobs } from '../../src/jobs/registry.js'
import type { CarolineJobs } from '../../src/jobs/registry.js'
import { createScheduler, type JobStep } from '../../src/jobs/scheduler.js'
import type { GoogleAuth } from '../../src/connectors/google/auth.js'
import { migratedDatabase } from './temp-database.js'

/** A clean checkout with no credentials, which is what the API tests care about. */
export const testConfig = loadConfig({ file: null, env: {} as NodeJS.ProcessEnv })

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
}

export async function testServer({
  jobs,
  database = migratedDatabase(),
  fetch,
  steps,
  google,
}: TestServerOptions = {}): Promise<TestServer> {
  const changes = createChangeFeed()
  const published: ChangeEvent[] = []
  changes.subscribe((event) => published.push(event))

  const built =
    jobs ??
    buildJobs({
      database,
      config: testConfig,
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
            timeZone: testConfig.jobs.timezone,
            backoffBaseMs: 60_000,
            backoffCeilingMs: 3_600_000,
            startupStaggerMs: 0,
            now: () => REQUEST_TIME,
            changes,
          }),
        }

  const finalJobs: CarolineJobs = google === undefined ? withSteps : { ...withSteps, google }

  const app = await buildServer({
    config: testConfig,
    database,
    changes,
    now: () => REQUEST_TIME,
    jobs: finalJobs,
  })
  openApps.push(app)

  return { app, database, changes, published, jobs: finalJobs }
}

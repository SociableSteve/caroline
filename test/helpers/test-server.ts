import { afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { loadConfig } from '../../src/config/load.js'
import type { Database } from '../../src/db/connection.js'
import { buildServer } from '../../src/server/app.js'
import { createChangeFeed, type ChangeEvent, type ChangeFeed } from '../../src/server/changes.js'
import type { SyncRunner } from '../../src/jobs/sync.js'
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
  /** A runner the jobs routes should use instead of the one built from the config. */
  readonly sync?: SyncRunner
}

export async function testServer({ sync }: TestServerOptions = {}): Promise<TestServer> {
  const database = migratedDatabase()
  const changes = createChangeFeed()
  const published: ChangeEvent[] = []
  changes.subscribe((event) => published.push(event))

  const app = await buildServer({
    config: testConfig,
    database,
    changes,
    now: () => REQUEST_TIME,
    ...(sync === undefined ? {} : { sync }),
  })
  openApps.push(app)

  return { app, database, changes, published }
}

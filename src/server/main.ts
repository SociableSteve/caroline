import { resolve } from 'node:path'
import { ConfigError, loadConfig, readConfigFile } from '../config/load.js'
import { openCarolineDatabase } from '../db/index.js'
import { buildConnectors, createSyncRunner } from '../jobs/sync.js'
import { buildServer } from './app.js'
import { createChangeFeed } from './changes.js'
import { version } from './version.js'

const configPath = resolve(process.env.CAROLINE_CONFIG ?? 'caroline.config.json')

async function start(): Promise<void> {
  const config = loadConfig({ file: readConfigFile(configPath), env: process.env })
  // Before the server, so a schema that cannot be brought up to date stops the process
  // rather than leaving it serving requests against a half-migrated database.
  const database = openCarolineDatabase(config)
  const changes = createChangeFeed()
  // The routes and the startup run share one runner, so its "already running" guard covers
  // both: a manual sync while the startup one is still going is answered, not queued.
  const sync = createSyncRunner({
    database,
    connectors: buildConnectors(config, database),
    changes,
  })
  const app = await buildServer({ config, database, changes, sync })

  await app.listen({ host: config.server.host, port: config.server.port })

  app.log.info(
    {
      version,
      database: config.database.path,
      github: config.integrations.github.configured ? 'configured' : 'not configured',
      google: config.integrations.google.configured ? 'configured' : 'not configured',
      llm: config.llm.configured ? config.llm.provider : 'not configured',
      llmContent: config.privacy.llmContent,
      storeContent: config.privacy.storeContent,
    },
    'Caroline is running',
  )

  // One sync as soon as the server is up, so a freshly started Caroline has something on the
  // board rather than an empty one until somebody presses a button. Deliberately not awaited:
  // it must not hold up serving, and `runSync` isolates every connector's failure into that
  // connector's own run record. The scheduler that keeps it going arrives in M5 (spec 06).
  void sync
    .run('startup')
    .then((outcome) => {
      if (outcome.status === 'ran') app.log.info({ results: outcome.summary.results }, 'Sync ran')
    })
    .catch((error: unknown) => app.log.error({ err: error }, 'Startup sync failed'))

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      // The database handle is released whether or not the server shut down cleanly, so a
      // failed close cannot leave the file locked behind an unhandled rejection.
      void (async () => {
        let exitCode = 0
        try {
          await app.close()
          // A sync in flight is still writing. Closing the handle underneath it turns an
          // orderly stop into a stack trace and a half-applied pass, so it is given a
          // bounded moment to finish first. `drain` resolves either way.
          await sync.drain()
        } catch (error) {
          exitCode = 1
          app.log.error(error, 'Server shutdown failed')
        } finally {
          database.close()
        }
        process.exit(exitCode)
      })()
    })
  }
}

try {
  await start()
} catch (error) {
  if (error instanceof ConfigError) {
    // A configuration problem is the user's to fix, so it gets a plain message and no stack.
    process.stderr.write(`Caroline cannot start: ${error.message}\n`)
    process.exit(1)
  }
  throw error
}

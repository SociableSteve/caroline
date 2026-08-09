import { resolve } from 'node:path'
import { ConfigError, loadConfig, readConfigFile } from '../config/load.js'
import { openCarolineDatabase } from '../db/index.js'
import { buildServer } from './app.js'
import { version } from './version.js'

const configPath = resolve(process.env.CAROLINE_CONFIG ?? 'caroline.config.json')

async function start(): Promise<void> {
  const config = loadConfig({ file: readConfigFile(configPath), env: process.env })
  // Before the server, so a schema that cannot be brought up to date stops the process
  // rather than leaving it serving requests against a half-migrated database.
  const database = openCarolineDatabase(config)
  const app = await buildServer({ config, database })

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

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      // The database handle is released whether or not the server shut down cleanly, so a
      // failed close cannot leave the file locked behind an unhandled rejection.
      void (async () => {
        let exitCode = 0
        try {
          await app.close()
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

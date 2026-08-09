import { resolve } from 'node:path'
import { ConfigError, loadConfig, readConfigFile } from '../config/load.js'
import { buildServer } from './app.js'
import { version } from './version.js'

const configPath = resolve(process.env.CAROLINE_CONFIG ?? 'caroline.config.json')

async function start(): Promise<void> {
  const config = loadConfig({ file: readConfigFile(configPath), env: process.env })
  const app = await buildServer({ config })

  await app.listen({ host: config.server.host, port: config.server.port })

  app.log.info(
    {
      version,
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
      void app.close().then(() => process.exit(0))
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

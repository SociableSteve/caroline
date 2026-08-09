import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyStatic from '@fastify/static'
import type { Config } from '../config/schema.js'
import { registerErrorHandling } from './errors.js'
import { registerHealthRoute } from './routes/health.js'
import { registerConfigRoute } from './routes/config.js'
import { scrubbingStream } from './log-redaction.js'

export interface BuildServerOptions {
  config: Config
  logger?: {
    level?: string
    /** Where log lines go. Wrapped in the secret scrubber before Fastify sees it. */
    stream?: NodeJS.WritableStream
  }
}

/** The built SPA, when `npm run build` has been run. Absent in development and in tests. */
const webRoot = fileURLToPath(new URL('../web', import.meta.url))

/**
 * Builds the Fastify app without listening, so tests can drive it with `inject`. The
 * server starts and serves whatever it can regardless of what is configured.
 */
export async function buildServer({
  config,
  logger,
}: BuildServerOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: logger?.level ?? process.env.CAROLINE_LOG_LEVEL ?? 'info',
      stream: scrubbingStream(logger?.stream ?? process.stdout, config),
    },
  })

  const serveWeb = existsSync(webRoot)
  if (serveWeb) {
    await app.register(fastifyStatic, { root: webRoot })
  }

  registerErrorHandling(app, config, { spaFallback: serveWeb })
  registerHealthRoute(app, config)
  registerConfigRoute(app, config)

  return app
}

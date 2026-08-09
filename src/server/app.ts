import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyStatic from '@fastify/static'
import { redactSecrets } from '../config/redact.js'
import type { Config } from '../config/schema.js'
import { registerErrorHandling } from './errors.js'
import { registerHealthRoute } from './routes/health.js'
import { registerConfigRoute } from './routes/config.js'
import {
  errorSerialiser,
  redactLogPayload,
  requestSerialiser,
  scrubbingStream,
} from './log-redaction.js'

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
      serializers: {
        req: requestSerialiser(),
        err: errorSerialiser(config),
      },
      formatters: {
        log: (payload) => redactLogPayload(payload, config) as Record<string, unknown>,
      },
      hooks: {
        // The message is not part of the payload the formatter sees, so it is redacted
        // here, still as a string and still before pino encodes it.
        logMethod(args, method) {
          return method.apply(
            this,
            args.map((argument) =>
              typeof argument === 'string' ? redactSecrets(argument, config) : argument,
            ) as Parameters<typeof method>,
          )
        },
      },
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

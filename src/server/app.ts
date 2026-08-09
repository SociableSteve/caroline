import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyStatic from '@fastify/static'
import { redactSecrets } from '../config/redact.js'
import type { Config } from '../config/schema.js'
import type { Database } from '../db/index.js'
import { createChangeFeed, type ChangeFeed } from './changes.js'
import { registerErrorHandling } from './errors.js'
import { registerHealthRoute } from './routes/health.js'
import { registerConfigRoute } from './routes/config.js'
import { registerChangesRoute } from './routes/changes.js'
import { registerTaskRoutes } from './routes/tasks.js'
import { registerProjectRoutes } from './routes/projects.js'
import {
  errorSerialiser,
  redactLogFields,
  requestSerialiser,
  scrubbingStream,
} from './log-redaction.js'

export interface BuildServerOptions {
  config: Config
  database: Database
  /**
   * The feed the task and project routes announce their writes on. One is created if none
   * is supplied; tests pass their own so they can watch what was published.
   */
  changes?: ChangeFeed
  /** The clock the routes stamp writes with. Injected so tests do not have to wait. */
  now?: () => number
  logger?: {
    level?: string
    /** Where log lines go. Wrapped in the secret scrubber before Fastify sees it. */
    stream?: NodeJS.WritableStream
  }
}

/** The built SPA, when `npm run build` has been run. Absent in development and in tests. */
const webRoot = fileURLToPath(new URL('../web', import.meta.url))

export interface RouteDependencies {
  config: Config
  database: Database
  changes: ChangeFeed
  now: () => number
}

/**
 * Every route the API serves, in one list. The test that asserts each one declares a schema
 * (spec 08 criterion 1) registers through here, so a route added without one cannot slip
 * past by living somewhere the test does not look.
 */
export function registerRoutes(
  app: FastifyInstance,
  { config, database, changes, now }: RouteDependencies,
): void {
  registerHealthRoute(app, config, database)
  registerConfigRoute(app, config)
  registerChangesRoute(app, changes)
  registerTaskRoutes(app, { database, changes, now })
  registerProjectRoutes(app, { database, changes, now })
}

/**
 * Builds the Fastify app without listening, so tests can drive it with `inject`. The
 * server starts and serves whatever it can regardless of what is configured.
 */
export async function buildServer({
  config,
  database,
  changes = createChangeFeed(),
  now = () => Date.now(),
  logger,
}: BuildServerOptions): Promise<FastifyInstance> {
  const app = Fastify({
    ajv: {
      customOptions: {
        // Fastify strips unknown fields by default. For this API that turns a typo into a
        // silent success: `?stauts=inbox` would return the whole table as though nothing
        // were wrong. Spec 08 criterion 1 asks for a 400 on a request that violates the
        // schema, and an unknown field violates `additionalProperties: false`.
        removeAdditional: false,
      },
    },
    logger: {
      level: logger?.level ?? process.env.CAROLINE_LOG_LEVEL ?? 'info',
      stream: scrubbingStream(logger?.stream ?? process.stdout, config),
      serializers: {
        req: requestSerialiser(),
        err: errorSerialiser(config),
      },
      formatters: {
        log: (payload) => redactLogFields(payload, config),
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
  registerRoutes(app, { config, database, changes, now })

  return app
}

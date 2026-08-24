import { existsSync } from 'node:fs'
import { join } from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyStatic from '@fastify/static'
import { redactSecrets } from '../config/redact.js'
import { WEB_BUILD_DIR } from './web-build-dir.js'
import type { Config } from '../config/schema.js'
import type { Database } from '../db/index.js'
import { registerAuthGate } from './auth-gate.js'
import { createAuthService, type AuthService } from '../auth/service.js'
import { buildJobs, type CarolineJobs } from '../jobs/registry.js'
import { createChangeFeed, type ChangeFeed } from './changes.js'
import { registerErrorHandling } from './errors.js'
import { registerHealthRoute } from './routes/health.js'
import { registerConfigRoute } from './routes/config.js'
import { registerChangesRoute } from './routes/changes.js'
import { registerTaskRoutes } from './routes/tasks.js'
import { registerProjectRoutes } from './routes/projects.js'
import { registerJobRoutes } from './routes/jobs.js'
import { registerPlanRoutes } from './routes/plan.js'
import { registerChatRoutes } from './routes/chat.js'
import { registerIntegrationRoutes } from './routes/integrations.js'
import { registerPrivacyRoutes } from './routes/privacy.js'
import { registerSettingsRoutes } from './routes/settings.js'
import { registerSpendRoutes } from './routes/spend.js'
import { registerAuthRoutes } from './routes/auth.js'
import { registerMcpRoutes } from '../mcp/route.js'
import { registerMcpOauthRoutes } from './routes/mcp-oauth.js'
import type { fetchClientMetadata } from '../mcp/oauth/client-metadata.js'
import { registerWellKnownRoutes } from './routes/well-known.js'
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
  /**
   * The scheduler, the connectors and the model runtime. One set is built from the config if none
   * is given. The scheduler is not started here: building the app and running background work are
   * separate decisions, and a test wants the first without the second.
   */
  jobs?: CarolineJobs
  /**
   * The auth service, built from the config if none is given. Separate from `jobs`'s own
   * `fetch`: a test that wants to stub the identity provider's discovery and token endpoints
   * should not have to also decide what the Google or LLM fetch does.
   */
  auth?: AuthService
  /** Injected in tests so discovery and the token exchange never reach a network. Ignored if
   * `auth` is supplied directly. */
  authFetch?: typeof globalThis.fetch
  /** Injected in tests so an MCP client's metadata document fetch never reaches a network. */
  mcpClientMetadataFetch?: typeof fetchClientMetadata
  logger?: {
    level?: string
    /** Where log lines go. Wrapped in the secret scrubber before Fastify sees it. */
    stream?: NodeJS.WritableStream
  }
  /**
   * Where the built SPA lives. Defaults to {@link resolveWebRoot}'s `process.cwd()`-anchored
   * guess, which is right for `npm run dev` and `npm run start` as both are run from the repo
   * root, but not for every deployment: a Docker `WORKDIR`, a pm2 config with no explicit
   * `cwd`, or a systemd unit missing `WorkingDirectory` can start the process somewhere else
   * entirely, and the default would then miss the built SPA silently. Set this explicitly
   * when the process's cwd is not the repo root. Also lets tests inject a path directly
   * instead of `chdir`-ing the whole process.
   *
   * `main.ts`, the real production entry point, wires this from `config.server.webRoot`
   * (`CAROLINE_WEB_ROOT` in the environment), which is how a deployment actually reaches
   * this option: nothing calls `buildServer` directly outside of tests.
   */
  webRoot?: string
}

/**
 * Where the built SPA's directory is, given the directory the process was started from.
 *
 * Anchored on `cwd` rather than `import.meta.url`: the latter resolves to the currently
 * *executing* module, which differs between `tsx watch src/server/main.ts` (dev, runs this
 * file from `src/server`) and `node dist/server/main.js` (prod, runs the compiled copy from
 * `dist/server`). `vite.config.ts` writes the built SPA to {@link WEB_BUILD_DIR} relative to
 * the repo root, so this only resolves correctly when `cwd` *is* the repo root: see
 * `webRoot` on {@link BuildServerOptions} for how a deployment whose cwd differs can
 * override it.
 */
export function resolveWebRoot(cwd: string = process.cwd()): string {
  return join(cwd, ...WEB_BUILD_DIR)
}

export interface RouteDependencies {
  config: Config
  database: Database
  changes: ChangeFeed
  now: () => number
  jobs: CarolineJobs
  auth: AuthService
  mcpClientMetadataFetch?: typeof fetchClientMetadata
}

/**
 * Every route the API serves, in one list. The test that asserts each one declares a schema
 * (spec 08 criterion 1) registers through here, so a route added without one cannot slip
 * past by living somewhere the test does not look.
 */
export function registerRoutes(
  app: FastifyInstance,
  { config, database, changes, now, jobs, auth, mcpClientMetadataFetch }: RouteDependencies,
): void {
  registerHealthRoute(app, config, database)
  registerConfigRoute(app, config)
  registerAuthRoutes(app, { config, auth })
  registerChangesRoute(app, changes, { auth })
  registerTaskRoutes(app, { database, changes, now })
  registerProjectRoutes(app, { database, changes, now })
  registerJobRoutes(app, { database, jobs })
  registerPlanRoutes(app, { config, database, jobs, now })
  registerChatRoutes(app, { config, database, changes, now, jobs })
  registerIntegrationRoutes(app, { config, database, google: jobs.google })
  registerPrivacyRoutes(app, { config, database, content: jobs.content, now })
  registerSettingsRoutes(app, { database, now })
  registerSpendRoutes(app, { config, database, now })
  // Off unless mcp.enabled, and registered here rather than in the shared list above: its own
  // encapsulation carries its own error handler, so it must be `app.register`ed rather than
  // called as a plain function on `app` the other routes are. Spec 12, criterion 5.
  registerMcpRoutes(app, { config, database, changes, now, jobs })
  // The authorisation server's own routes and the two well-known metadata documents, both off
  // unless mcp.enabled (spec 12, criterion 5): a document describing a service that is not
  // running is not a lesser version of the truth.
  registerMcpOauthRoutes(app, {
    config,
    database,
    now,
    ...(mcpClientMetadataFetch === undefined
      ? {}
      : { fetchClientMetadata: mcpClientMetadataFetch }),
  })
  registerWellKnownRoutes(app, config)
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
  jobs = buildJobs({ database, config, changes, now }),
  authFetch,
  auth: authOverride,
  mcpClientMetadataFetch,
  logger,
  webRoot = resolveWebRoot(),
}: BuildServerOptions): Promise<FastifyInstance> {
  const app = Fastify({
    // Written out explicitly rather than left to the default, so the intent is legible and a
    // request's address can never be taken from a caller-supplied header. Spec 13.
    trustProxy: false,
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

  const auth =
    authOverride ??
    createAuthService({
      config,
      database,
      now,
      ...(authFetch === undefined ? {} : { fetch: authFetch }),
      // Spec 13 criterion 16: the operator is the one person with the log, and a refused
      // login is the thing they need to know about. The body a caller receives names no
      // address; this line, which only the operator sees, names the subject the provider
      // attested.
      onLoginRefused: (subject) => {
        app.log.warn({ subject }, 'login refused: identity is not on auth.allow')
      },
    })

  const serveWeb = existsSync(webRoot)
  if (serveWeb) {
    await app.register(fastifyStatic, { root: webRoot })
  }

  registerErrorHandling(app, config, { spaFallback: serveWeb })
  registerAuthGate(app, config, auth)
  registerRoutes(app, {
    config,
    database,
    changes,
    now,
    jobs,
    auth,
    ...(mcpClientMetadataFetch === undefined ? {} : { mcpClientMetadataFetch }),
  })

  return app
}

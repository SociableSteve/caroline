import { resolve } from 'node:path'
import { ConfigError, loadConfig, readConfigFile } from '../config/load.js'
import { openCarolineDatabase } from '../db/index.js'
import { buildJobs } from '../jobs/registry.js'
import { buildServer } from './app.js'
import { createChangeFeed } from './changes.js'
import { installCrashHandlers } from './crash.js'
import { createLogDestination } from './log-destination.js'
import { deferredLog } from './log.js'
import { version } from './version.js'

const configPath = resolve(process.env.CAROLINE_CONFIG ?? 'caroline.config.json')

async function start(): Promise<void> {
  const config = loadConfig({ file: readConfigFile(configPath), env: process.env })
  // Before the server, so a schema that cannot be brought up to date stops the process
  // rather than leaving it serving requests against a half-migrated database.
  const database = openCarolineDatabase(config)
  // Both destinations, behind the one scrubbing stream the server wraps this in: the file that
  // survives the process, and stdout so a supervisor that captures it still works. Spec 14.
  const destination = createLogDestination({ config })
  const changes = createChangeFeed()
  // The jobs are built before the server and the server owns the logger, so they take a handle
  // that is pointed at it below, before the scheduler starts and before any job can run. Spec 14.
  const log = deferredLog()
  // The routes and the scheduler share one set of jobs, so the overlap guard covers both: a manual
  // run while a scheduled one is still going is answered rather than queued.
  const jobs = buildJobs({ database, config, changes, log })
  const app = await buildServer({
    config,
    database,
    changes,
    jobs,
    logger: { stream: destination.stream },
    // `resolveWebRoot()`'s own default is right for `npm run dev` and `npm run start`, both
    // run from the repo root; `server.webRoot`/`CAROLINE_WEB_ROOT` is the escape hatch for a
    // deployment whose cwd is not (a Docker WORKDIR, a pm2 config or a systemd unit with no
    // explicit cwd), where that default would otherwise silently resolve to the wrong path.
    ...(config.server.webRoot === null ? {} : { webRoot: config.server.webRoot }),
  })

  log.attach(app.log)

  // Before `listen`, so a crash while the port is being bound is in the record too. The line is
  // written synchronously to the file, which is what makes it survive an exit that follows it
  // immediately. Spec 14, criterion 8.
  installCrashHandlers({ log: app.log, close: () => destination.close() })

  await app.listen({ host: config.server.host, port: config.server.port })

  app.log.info(
    {
      version,
      database: config.database.path,
      // Named at boot, because the first thing somebody diagnosing a fault needs to know is where
      // the record of it is. Null says the durable log is off or could not be opened, and the
      // reason for the second was said on stdout when it happened.
      log: destination.path,
      logLevel: config.logging.level,
      github: config.integrations.github.configured ? 'configured' : 'not configured',
      google: jobs.google.isConnected()
        ? 'connected'
        : config.integrations.google.configured
          ? 'configured, not connected'
          : 'not configured',
      llm: config.llm.configured ? config.llm.provider : 'not configured',
      llmContent: config.privacy.llmContent,
      storeContent: config.privacy.storeContent,
      timezone: config.jobs.timezone,
      schedules: config.jobs.schedules,
    },
    'Caroline is running',
  )

  // Only once the server is listening: the scheduler's cold-start catch-up runs a job whose last
  // success is older than one interval, which on a fresh checkout is all of them, and none of that
  // should hold up serving. Spec 06, startup.
  jobs.scheduler.start()

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      // The database handle is released whether or not the server shut down cleanly, so a
      // failed close cannot leave the file locked behind an unhandled rejection.
      void (async () => {
        let exitCode = 0
        jobs.scheduler.stop()

        try {
          await app.close()
        } catch (error) {
          exitCode = 1
          app.log.error(error, 'Server shutdown failed')
        }

        try {
          // Its own step, so a server that failed to close still waits. A job in flight is still
          // writing, and closing the handle underneath it turns an orderly stop into a stack trace
          // and a half-applied pass. `drain` resolves either way.
          await jobs.scheduler.drain()
        } catch (error) {
          exitCode = 1
          app.log.error(error, 'Waiting for jobs to finish failed')
        } finally {
          database.close()
          // Last, so anything the shutdown had to say is already in the file.
          destination.close()
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

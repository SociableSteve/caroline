/**
 * The crash handlers. Spec 14, criterion 8: an uncaught exception and an unhandled rejection reach
 * the same scrubbed destination as every other line, with the stack and the fact that the process is
 * going away, and the process then exits non-zero.
 *
 * Driven against an injected `process`, because installing handlers on the real one would have a
 * failing test elsewhere in the suite take this file's exit path.
 */
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config/load.js'
import { buildServer } from '../../src/server/app.js'
import { CRASH_EXIT_CODE, installCrashHandlers } from '../../src/server/crash.js'
import { captureLog } from '../helpers/log-capture.js'
import { migratedDatabase } from '../helpers/temp-database.js'

const secrets = { GITHUB_TOKEN: 'ghp_supersecret' } as NodeJS.ProcessEnv

/** A `process` that records what was registered rather than registering it. */
function fakeProcess(): {
  process: Pick<NodeJS.Process, 'on'>
  raise: (event: string, value: unknown) => void
} {
  const handlers = new Map<string, (value: unknown) => void>()

  return {
    process: {
      on(event: string, handler: (value: unknown) => void) {
        handlers.set(event, handler)
        return this as unknown as NodeJS.Process
      },
    } as unknown as Pick<NodeJS.Process, 'on'>,
    raise: (event, value) => handlers.get(event)?.(value),
  }
}

async function crashing(event: string, value: unknown) {
  const { lines, stream } = captureLog()
  const config = loadConfig({ file: null, env: secrets })
  const app = await buildServer({
    config,
    database: migratedDatabase(),
    logger: { level: 'info', stream },
  })
  const { process: target, raise } = fakeProcess()
  const exits: number[] = []
  let closed = 0

  installCrashHandlers({
    log: app.log,
    close: () => {
      closed += 1
    },
    exit: (code) => exits.push(code),
    process: target,
  })

  raise(event, value)
  await app.close()

  return { logged: lines.join('\n'), exits, closed }
}

describe('a crash is in the record (spec 14 criterion 8)', () => {
  it('logs an uncaught exception with its stack and exits non-zero', async () => {
    const { logged, exits, closed } = await crashing(
      'uncaughtException',
      new Error('the connection went away'),
    )

    expect(logged).toContain('the process crashed')
    expect(logged).toContain('the connection went away')
    expect(logged).toContain('"kind":"uncaughtException"')
    // The stack, because the line exists to say where it happened.
    expect(logged).toContain('"stack":"Error: the connection went away\\n    at ')
    // `fatal` is level 60 in pino's numbering.
    expect(logged).toContain('"level":60')
    expect(exits).toEqual([CRASH_EXIT_CODE])
    expect(closed).toBe(1)
  })

  it('logs an unhandled rejection, wrapping a reason that is not an error', async () => {
    const { logged, exits } = await crashing('unhandledRejection', 'no reason given')

    expect(logged).toContain('"kind":"unhandledRejection"')
    expect(logged).toContain('no reason given')
    expect(exits).toEqual([CRASH_EXIT_CODE])
  })

  it('redacts a secret in the crash it reports', async () => {
    const { logged } = await crashing(
      'uncaughtException',
      new Error('upstream rejected ghp_supersecret'),
    )

    expect(logged).not.toContain('ghp_supersecret')
    expect(logged).toContain('upstream rejected [redacted]')
  })

  it('still exits non-zero when the logger itself cannot log', async () => {
    const { process: target, raise } = fakeProcess()
    const exits: number[] = []

    installCrashHandlers({
      log: {
        fatal: () => {
          throw new Error('the log has gone')
        },
      },
      exit: (code) => exits.push(code),
      process: target,
    })

    raise('uncaughtException', new Error('the connection went away'))

    // A logger that cannot log a crash must not turn it into a different crash, and must not
    // swallow the exit code a supervisor reads.
    expect(exits).toEqual([CRASH_EXIT_CODE])
  })
})

/**
 * The crash is in the record. Spec 14.
 *
 * `SIGINT` and `SIGTERM` already had an orderly, logged shutdown. `uncaughtException` and
 * `unhandledRejection` did not: Node prints them to stderr and exits, so the one line most worth
 * having was neither scrubbed by the stream that scrubs everything else nor kept by anything.
 *
 * They are logged at `fatal` through the same logger as every other line, which means the same
 * three redaction points and the same durable destination. The file's writes are synchronous
 * (`./log-file.ts`), so the line is on disk before this returns: waiting on an asynchronous flush
 * during an uncaught exception is how it would be lost.
 */
import type { FastifyBaseLogger } from 'fastify'

export interface CrashHandlerOptions {
  /** The process logger. Fatal goes through it, so the crash is redacted like anything else. */
  readonly log: Pick<FastifyBaseLogger, 'fatal'>
  /** Flushes and closes the durable destination, once the line has been written. */
  readonly close?: () => void
  /** Injected in tests. The real one ends the process. */
  readonly exit?: (code: number) => void
  /** Injected in tests, so the suite does not install handlers on the real process. */
  readonly process?: Pick<NodeJS.Process, 'on'>
}

/** The code a crash exits with. Non-zero, so a supervisor still sees a crash as one. */
export const CRASH_EXIT_CODE = 1

export function installCrashHandlers({
  log,
  close = () => {},
  exit = (code) => process.exit(code),
  process: target = process,
}: CrashHandlerOptions): void {
  const report = (error: unknown, kind: 'uncaughtException' | 'unhandledRejection'): void => {
    try {
      log.fatal(
        {
          // `err` reaches the error serialiser, which redacts the message and the stack while they
          // are still strings (`./log-redaction.ts`). A rejection with a non-error reason is wrapped
          // rather than logged raw, so the stack of the throw site is not the only thing recorded.
          err: error instanceof Error ? error : new Error(String(error)),
          kind,
        },
        'Caroline is stopping: the process crashed',
      )
    } catch {
      // A logger that cannot log a crash must not turn it into a different crash. The exit code
      // below is what is left of the report in that case.
    }

    try {
      close()
    } catch {
      // Same reasoning: the line is already written, and closing is tidiness.
    }

    // The crash is not swallowed. A supervisor decides whether to restart on the exit code, and a
    // crash that exited zero because it was logged nicely would be a worse bug than the one being
    // diagnosed.
    exit(CRASH_EXIT_CODE)
  }

  target.on('uncaughtException', (error: unknown) => {
    report(error, 'uncaughtException')
  })

  target.on('unhandledRejection', (reason: unknown) => {
    report(reason, 'unhandledRejection')
  })
}

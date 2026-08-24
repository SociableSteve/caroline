/**
 * Where a log line goes once it has been scrubbed: the durable file, and stdout beside it. Spec 14.
 *
 * The order matters and is the whole design. `scrubbingStream` (`./log-redaction.ts`) wraps this,
 * so both sides are downstream of the one point that makes a line safe, and there is no second path
 * to disk for a secret to take. Stdout stays a tee rather than being replaced, so a supervisor that
 * already captures it keeps working exactly as it did.
 */
import { dirname, join, resolve } from 'node:path'
import { Writable } from 'node:stream'
import type { Config } from '../config/schema.js'
import { LOG_FILE_NAME, noLogFile, openLogFile, type LogFile } from './log-file.js'

export { LOG_FILE_NAME }

/**
 * Caroline's data directory: where the database is, which is where the Google token file already
 * lives (`googleTokenPath` in `src/config/load.ts`). Derived rather than configured for the same
 * reason, so that spec 09's promise that nothing Caroline creates lives outside its data directory
 * holds for a `database.path` pointing somewhere of the user's own. An in-memory or URI database
 * writes no file, and `dirname` of it resolves to the working directory, which is exactly where the
 * token file for such an install goes: one rule, not two.
 */
export function carolineDataDirectory(config: Config): string {
  return resolve(dirname(config.database.path))
}

/** Where the log files go, configured or defaulted. Spec 14, criterion 13. */
export function logDirectory(config: Config): string {
  const configured = config.logging.file.directory
  return configured === null ? join(carolineDataDirectory(config), 'logs') : resolve(configured)
}

export interface LogDestination {
  /** What pino writes to, once wrapped in the scrubbing stream. */
  readonly stream: Writable
  /** The live log file, or null when nothing durable is being written. */
  readonly path: string | null
  close(): void
}

export interface LogDestinationOptions {
  readonly config: Config
  /** Injected in tests, so nothing in the suite writes to the real stdout. */
  readonly stdout?: NodeJS.WritableStream
  readonly now?: () => number
}

/**
 * The tee. Each side is disabled on its first failure and the fact is reported once through the
 * other, because the two fail for unrelated reasons: a piped process going away closes stdout, and
 * a full disk stops the file. Neither may take the other down, and neither may throw out of a log
 * write. Spec 14, criterion 7.
 */
export function createLogDestination({
  config,
  stdout = process.stdout,
  now,
}: LogDestinationOptions): LogDestination {
  let terminal: NodeJS.WritableStream | null = stdout
  let file: LogFile = noLogFile()

  const say = (message: string): void => {
    try {
      terminal?.write(`${message}\n`)
    } catch {
      // Nowhere left to say it. The line itself is still written wherever it can be.
    }
  }

  if (config.logging.file.enabled) {
    file = openLogFile({
      directory: logDirectory(config),
      maxBytes: config.logging.file.maxBytes,
      maxFiles: config.logging.file.maxFiles,
      retainDays: config.logging.file.retainDays,
      onProblem: say,
      ...(now === undefined ? {} : { now }),
    })
  }

  /**
   * Said once, into the file, and stdout is not tried again: a stream that has gone will not come
   * back, and complaining per line would fill the file with the complaint instead of the log.
   */
  const disableTerminal = (error: unknown): void => {
    if (terminal === null) return

    terminal = null
    const detail = error instanceof Error ? error.message : String(error)
    file.write(
      `${JSON.stringify({
        level: 40,
        time: Date.now(),
        msg: `Caroline can no longer write log lines to stdout: ${detail}. The log file is unaffected.`,
      })}\n`,
    )
  }

  /*
   * `EPIPE` on a pipe whose reader has gone arrives as an `error` event rather than as a throw, and
   * an unhandled one on stdout takes the process down: the failure this listener exists for would
   * otherwise be a crash caused by logging. A synchronous throw (a stream already destroyed) is
   * caught below, because only one of the two paths delivers each kind of failure.
   */
  stdout.on('error', disableTerminal)

  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      const line = String(chunk)

      // The file first: it is the destination that survives the process, so a stdout that has gone
      // away must not cost the line that would have explained why.
      file.write(line)

      if (terminal !== null) {
        try {
          terminal.write(line)
        } catch (error) {
          disableTerminal(error)
        }
      }

      callback()
    },
  })

  return {
    stream,
    get path() {
      return file.path
    },
    close() {
      stdout.removeListener('error', disableTerminal)
      file.close()
    },
  }
}

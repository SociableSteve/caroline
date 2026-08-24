/**
 * The durable half of the log destination: one file, rotated by size, bounded by a file count and
 * a day bound. Spec 14.
 *
 * Written here rather than taken from a pino transport, and the reason is spec 09's rather than
 * taste. A transport runs in a worker thread and receives lines pino has already encoded, which is
 * past `scrubbingStream`, the last of the three points that make a line safe. A durable
 * destination the scrubber does not cover is the one destination that most needs covering, because
 * a line in a file is there until somebody deletes it. So this is a plain sink that the scrubbing
 * stream writes to, and rotation is code rather than a dependency.
 *
 * Every write is synchronous, on a descriptor opened once. That is what makes the crash path work:
 * an asynchronous flush during `uncaughtException` is how the line most worth having gets lost, and
 * a sink with no buffer has no flush to lose.
 */
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'

/** The live file. Rotations are this name with `.1`, `.2` and so on appended. */
export const LOG_FILE_NAME = 'caroline.log'

/**
 * Owner only, the modes spec 09 sets on the data directory and the database, for the reason it
 * gives: filesystem permissions are the whole of the protection at rest, and a default umask
 * leaves a new file world-readable.
 */
const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600

/** How often an ordinary write may stop to age files out. Spec 14, "What rotates". */
const PRUNE_INTERVAL_MS = 3_600_000

/** Whether a name is the live log or one of its rotations, and nothing else in the directory. */
export function isLogFileName(name: string): boolean {
  return name === LOG_FILE_NAME || /^caroline\.log\.[1-9][0-9]*$/.test(name)
}

/** The paths this sink owns, live file first, whether or not they exist. */
export function logFilePaths(directory: string, maxFiles: number): readonly string[] {
  return [
    join(directory, LOG_FILE_NAME),
    ...Array.from({ length: Math.max(0, maxFiles - 1) }, (_unused, index) =>
      join(directory, `${LOG_FILE_NAME}.${index + 1}`),
    ),
  ]
}

export interface LogFileOptions {
  readonly directory: string
  readonly maxBytes: number
  /** Counting the live file, so `maxBytes * maxFiles` is the ceiling on the disk this occupies. */
  readonly maxFiles: number
  readonly retainDays: number
  readonly now?: () => number
  /**
   * Told once, the first time the filesystem refuses something. The caller reports it on the other
   * side of the tee: a log file that cannot be opened is worth saying out loud and is not worth
   * refusing to serve over. Spec 14, criterion 6.
   */
  readonly onProblem?: (message: string) => void
}

export interface LogFile {
  /** Appends one already-formatted, already-scrubbed line. Never throws. */
  write(line: string): void
  close(): void
  /** The live file, or null when nothing durable is being written. */
  readonly path: string | null
}

/** A sink that keeps nothing, for a configuration with the file turned off. */
export function noLogFile(): LogFile {
  return { write: () => {}, close: () => {}, path: null }
}

export function openLogFile({
  directory,
  maxBytes,
  maxFiles,
  retainDays,
  now = () => Date.now(),
  onProblem = () => {},
}: LogFileOptions): LogFile {
  const livePath = join(directory, LOG_FILE_NAME)
  let descriptor: number | null = null
  let size = 0
  let lastPrunedAt = 0
  let reported = false

  /**
   * The first failure disables the sink and is said once. Every line after it would produce the
   * same message about the same file, and a log that fills stdout with complaints about not being
   * a log is worse than one that stopped.
   */
  function giveUp(action: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error)
    if (descriptor !== null) {
      try {
        closeSync(descriptor)
      } catch {
        // Already unusable. There is nothing left to salvage by reporting a second failure.
      }
      descriptor = null
    }
    if (reported) return

    reported = true
    onProblem(
      `Caroline cannot ${action} its log file at ${livePath}: ${detail}. Logging continues on stdout only.`,
    )
  }

  /**
   * Removes a rotated file whose last modification is older than the day bound, and any rotation
   * beyond the file count (which is how a lowered `maxFiles` takes effect rather than leaving the
   * files the old bound allowed). The live file is never removed: it is the current record, and its
   * age says only that nothing has happened lately.
   */
  function prune(): void {
    lastPrunedAt = now()
    const oldest = now() - retainDays * 86_400_000

    let names: string[]
    try {
      names = readdirSync(directory)
    } catch {
      // Not fatal, and not worth disabling the sink over: the file is open and writable, and the
      // bound is applied again at the next rotation.
      return
    }

    for (const name of names) {
      if (name === LOG_FILE_NAME || !isLogFileName(name)) continue

      const path = join(directory, name)
      const index = Number(name.slice(`${LOG_FILE_NAME}.`.length))
      try {
        if (index >= maxFiles || statSync(path).mtimeMs < oldest) rmSync(path, { force: true })
      } catch {
        // A file that will not go is left where it is. The bound is a promise about what this
        // writes, not a licence to throw out of a log write.
      }
    }
  }

  function open(): void {
    try {
      mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE })
      descriptor = openSync(livePath, 'a', FILE_MODE)
      size = fstatSync(descriptor).size
      // At open, so an instance restarted after a long absence brings what it finds into the bound.
      // A bound that only holds while the process is busy is not a bound. Spec 14, criterion 5.
      prune()
    } catch (error) {
      giveUp('open', error)
    }
  }

  /**
   * The renames, longest-lived first, so nothing is overwritten while it still has a slot to move
   * into. The rotation that would fall off the end is removed rather than renamed.
   */
  function rotate(): void {
    if (descriptor === null) return

    try {
      closeSync(descriptor)
      descriptor = null

      for (let index = maxFiles - 1; index >= 1; index -= 1) {
        const from = index === 1 ? livePath : `${livePath}.${index - 1}`
        const to = `${livePath}.${index}`
        if (index === maxFiles - 1 && existsSync(to)) rmSync(to, { force: true })
        if (existsSync(from)) renameSync(from, to)
      }

      // `maxFiles` of 1 keeps no rotations at all, so the live file is simply started again.
      if (maxFiles === 1) rmSync(livePath, { force: true })

      descriptor = openSync(livePath, 'a', FILE_MODE)
      size = 0
      prune()
    } catch (error) {
      giveUp('rotate', error)
    }
  }

  open()

  return {
    get path() {
      return descriptor === null ? null : livePath
    },

    write(line: string): void {
      if (descriptor === null) return

      const bytes = Buffer.byteLength(line)
      // Rotated before the write rather than after it, so a line is never split across two files
      // and a single line longer than the cap still lands whole in a file of its own. Spec 14,
      // criterion 3.
      if (size > 0 && size + bytes > maxBytes) rotate()
      if (descriptor === null) return

      try {
        writeSync(descriptor, line)
        size += bytes
        // The day bound, on an instance whose log is quiet enough never to rotate. Throttled, so
        // an ordinary write costs a comparison rather than a directory read.
        if (now() - lastPrunedAt >= PRUNE_INTERVAL_MS) prune()
      } catch (error) {
        giveUp('write to', error)
      }
    },

    close(): void {
      if (descriptor === null) return
      try {
        closeSync(descriptor)
      } catch {
        // Closing a descriptor that is already gone is not worth a message on the way out.
      }
      descriptor = null
    },
  }
}

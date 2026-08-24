/**
 * Deleting everything Caroline has: the database, its SQLite sidecars, the Google token file and
 * the log (spec 14).
 * Spec 09 promises one documented command, and that nothing Caroline creates lives outside its
 * data directory. This is the half that decides what those files are and removes them; `delete.ts`
 * is the command that reports on it.
 *
 * The data directory is removed only when it held something of Caroline's and is empty afterwards.
 * Somebody may have pointed `database.path` at a directory of their own, and a command that deleted
 * a directory it did not create would be a worse failure than one that leaves an empty folder.
 */
import { existsSync, lstatSync, readdirSync, rmSync, rmdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { Config } from '../config/schema.js'
import { isFilePath } from '../db/connection.js'
import { logDirectory } from '../server/log-destination.js'
import { isLogFileName } from '../server/log-file.js'

/**
 * The log files in a directory, by the names this command's own logger gives them: `caroline.log`
 * and its numbered rotations, and nothing else in there. Enumerated rather than named, because how
 * many rotations exist depends on how long the instance ran, and enumerated by name rather than by
 * everything present, because the directory may hold somebody else's file and this command does not
 * remove those. Spec 14, and spec 09's "it deletes its own files".
 *
 * Listed whatever `logging.file.enabled` says: a log written before somebody turned the file off is
 * still Caroline's, and still there.
 */
function logFilesIn(directory: string): readonly string[] {
  try {
    return readdirSync(directory)
      .filter(isLogFileName)
      .toSorted()
      .map((name) => join(directory, name))
  } catch {
    // Not there, or not readable. Either way there is nothing this can say it would remove; a
    // directory that cannot be read is reported by `deleteCarolineData`, which reads it too.
    return []
  }
}

/**
 * Every path Caroline writes, in the order a person would want to read them.
 *
 * The SQLite sidecars are named rather than assumed absent: a clean close removes the
 * write-ahead log, and a kill or a crash does not, so the state this command most often meets is
 * one where they are still there. `-journal` is listed too, because a filesystem that will not
 * take WAL leaves SQLite in rollback-journal mode instead.
 *
 * The token file's temporary sibling is listed for the same reason: `writeTokens` renames it over
 * the target, and an interrupted write leaves it holding a real refresh token.
 */
export function carolineDataPaths(config: Config): readonly string[] {
  // Resolved, because `database.path` defaults to the relative `./data/caroline.db` and the paths
  // here are compared against what `readdirSync` gives back: `./data/caroline.db` and
  // `data/caroline.db` are the same file and not the same string, and the difference showed up as a
  // dry run reporting Caroline's own database as somebody else's file. `tokenPath` is already
  // absolute. An absolute path is also the right thing to print in a deletion command's output.
  const database = resolve(config.database.path)
  const tokens = config.integrations.google.tokenPath

  return [
    // An in-memory or URI database writes no file, so there is none to remove. The token file is
    // still Caroline's, and is still where it always was.
    ...(isFilePath(config.database.path)
      ? [database, `${database}-wal`, `${database}-shm`, `${database}-journal`]
      : []),
    tokens,
    `${tokens}.tmp`,
    ...logFilesIn(logDirectory(config)),
  ]
}

/** What the filesystem said, for a report rather than for a stack trace. */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Whether a path is a symbolic link. False when it cannot be looked at, which is the safe answer:
 * every caller uses this to decide whether to leave something alone.
 */
function isLink(path: string): boolean {
  try {
    return lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() === true
  } catch {
    return false
  }
}

/** A path that could not be removed, and what the filesystem said about it. */
export interface DeletionFailure {
  readonly path: string
  readonly message: string
}

export interface DeletionReport {
  /** The data directory, which is where every path above lives. */
  readonly directory: string
  /** What was removed, or on a dry run what would be. */
  readonly removed: readonly string[]
  /**
   * The subset of `removed` that was a symbolic link. The link is what went; whatever it pointed at
   * is somebody's deliberate indirection and was not followed, and a report that did not say so
   * would have somebody believe a database on another disk had been deleted.
   */
  readonly symlinks: readonly string[]
  /**
   * Anything else in the data directory. Not Caroline's, so not deleted, but said out loud. A file of
   * Caroline's that would not go is in `failed` rather than here: it is still on disk, but it is not
   * somebody else's.
   */
  readonly leftBehind: readonly string[]
  /** Caroline's own files that would not go, the data directory included. Empty in the ordinary case. */
  readonly failed: readonly DeletionFailure[]
  /**
   * Whether the data directory itself went, or on a dry run whether it would. Reported the same way
   * as `removed`, because a command that promises to list what it would remove and then silently
   * removes a directory has broken the promise the dry run exists to keep.
   */
  readonly directoryRemoved: boolean
}

export interface DeleteOptions {
  /** Report what would go without touching anything. */
  readonly dryRun?: boolean
}

export function deleteCarolineData(
  config: Config,
  { dryRun = false }: DeleteOptions = {},
): DeletionReport {
  const directory = dirname(resolve(config.database.path))
  const removed: string[] = []
  const symlinks: string[] = []
  const failed: DeletionFailure[] = []

  for (const path of carolineDataPaths(config)) {
    let entry
    try {
      entry = lstatSync(path, { throwIfNoEntry: false })
    } catch (error) {
      // `throwIfNoEntry` covers a path that is not there, and nothing else: a directory the account
      // cannot read still throws. Looking is as much a step that can fail as removing is, and by this
      // point in the loop files may already have gone, so it is reported the same way.
      failed.push({ path, message: reason(error) })
      continue
    }

    if (entry === undefined) continue

    // A directory carrying one of Caroline's names is not one of Caroline's files. `rmSync` without
    // `recursive` throws on it, which would abort the command partway through having deleted the
    // rest, and adding `recursive` would delete somebody's directory on the strength of its name.
    // It is left where it is, and the listing below reports it as what it is.
    if (entry.isDirectory()) continue

    // A symlink is removed as a link rather than followed, which is what `rmSync` does: pointing the
    // database at another disk is a reasonable thing to have done, and deleting the link is the most
    // this command may conclude from it.
    const entryIsLink = entry.isSymbolicLink()

    if (!dryRun) {
      try {
        rmSync(path, { force: true })
      } catch (error) {
        // A read-only mount, a locked file, a permission the account does not have. The rest of the
        // files are still worth removing, and the report is the record of what happened: throwing
        // here would leave a partial deletion described by a stack trace.
        failed.push({ path, message: reason(error) })
        continue
      }
    }

    // Recorded as a link only now, so that `symlinks` stays a subset of `removed` and the output
    // cannot describe how something went that did not go.
    if (entryIsLink) symlinks.push(path)
    removed.push(path)
  }

  /*
   * The log directory, which is the one place Caroline writes that is a directory of its own (spec
   * 14). Its files went with the rest above, and the directory follows the same rule the data
   * directory follows one level up: it goes only when Caroline had written a file in it, it is empty
   * afterwards and it is not a link. Anything else in there is somebody's and is reported instead,
   * which is also what stops the data directory going while it still holds this one.
   *
   * A log directory that is the data directory itself, or that is somewhere else entirely, is not
   * removed by this: the first is decided below, and the second is a directory the user named, where
   * removing it would be exactly the overreach this command refuses.
   */
  const logs = logDirectory(config)
  const logsAreOurs = logs !== directory && dirname(logs) === directory
  let logsRemoved = false
  /** Whether Caroline had written a log file in there, which is what makes the directory its. */
  let wroteLogs = false
  const logsLeftBehind: string[] = []

  if (logsAreOurs && existsSync(logs)) {
    let logEntries: string[] | null = null
    try {
      logEntries = readdirSync(logs)
    } catch (error) {
      failed.push({ path: logs, message: reason(error) })
    }

    if (logEntries !== null) {
      const alreadyAccountedFor = new Set([
        ...(dryRun ? removed : []),
        ...failed.map((failure) => failure.path),
      ])
      logsLeftBehind.push(
        ...logEntries
          .map((entry) => join(logs, entry))
          .filter((path) => !alreadyAccountedFor.has(path))
          .toSorted(),
      )

      wroteLogs = removed.some((path) => dirname(path) === logs && !symlinks.includes(path))

      if (wroteLogs && logsLeftBehind.length === 0 && !isLink(logs)) {
        logsRemoved = true
        if (!dryRun) {
          try {
            rmdirSync(logs)
          } catch (error) {
            logsRemoved = false
            failed.push({ path: logs, message: reason(error) })
          }
        }
      }
    }
  }

  // Reported alongside the files, because it is one more thing this command removed and a dry run
  // has to say so before a real one does it.
  if (logsRemoved) removed.push(logs)

  // A database that is not a file on disk (`:memory:`, or a `file:` URI) has no directory of
  // Caroline's making: `dirname` of it resolves to the working directory, and neither listing that
  // nor being one empty directory away from removing it is anything this command should do. The
  // token file is still removed above, which is the whole of what such an installation writes.
  const ownsDirectory = isFilePath(config.database.path)

  // Read after the removals, so what is reported is what is actually still there. Caroline's own
  // paths are subtracted: the ones a dry run would have removed, and the ones a real run could not,
  // which are still on disk and are already reported as failures. Saying "Caroline did not write
  // this" about a token file it could not delete would be false about a live refresh token. What is
  // deliberately not subtracted is a directory that collided with one of Caroline's names, which was
  // not removed because it is not Caroline's and belongs in this list.
  // The log directory counts as ours only where Caroline had written a log file in it: an empty one
  // it never wrote in is indistinguishable from a directory somebody made, and claiming it would
  // have the data directory removed out from under it. Where it is ours and is still there, what is
  // in it is listed instead, so the output names the file somebody would want to look at rather than
  // the directory it is in.
  const ours = new Set([
    ...(dryRun ? removed : []),
    ...failed.map((failure) => failure.path),
    ...(wroteLogs ? [logs] : []),
  ])

  // Null where the directory was not read: it is not there, it is not Caroline's to read, or reading
  // it failed. An empty list and an unread list are different answers, and the second must not let
  // the directory be removed for looking empty.
  let entries: string[] | null = null
  if (ownsDirectory && existsSync(directory)) {
    try {
      entries = readdirSync(directory)
    } catch (error) {
      failed.push({ path: directory, message: reason(error) })
    }
  }

  const leftBehind = [
    ...(entries ?? [])
      .map((entry) => join(directory, entry))
      .filter((path) => !ours.has(path))
      .toSorted(),
    // What is in the log directory and is not Caroline's. Listed here rather than as the directory
    // itself, so the output names the file somebody would want to look at.
    ...logsLeftBehind,
  ]

  // A file of Caroline's having been removed is what says this directory was Caroline's. Without that
  // check, a `database.path` pointing into an empty directory of somebody's own has that directory
  // deleted by a command that had just reported finding nothing of Caroline's in it. A failure leaves
  // a file in place, so it stops the directory going too, by the same rule as anything else still in
  // it.
  //
  // A link does not count towards it. Somebody put that link there by hand, so a directory whose only
  // Caroline-shaped entry was one is a directory Caroline never wrote a byte in, and the same
  // reasoning that says a link may only be unlinked says its removal proves nothing about the folder.
  //
  // A symbolic link is not a directory Caroline created either, whatever it points at, and
  // `rmdirSync` throws ENOTDIR on one. Symlinking the data directory onto another volume is the same
  // reasonable thing as symlinking the database, and the link is left where it is.
  //
  // Filtered by `dirname`, the way the log directory's own version of this check above is, because
  // `carolineDataPaths` reaches outside this directory: `logging.file.directory` may name a
  // directory of the user's own, and a `caroline.log` removed from there says nothing whatever
  // about the data directory. Without the filter, removing that external file made a data
  // directory Caroline had never written in look like one it had, and the empty directory was then
  // removed: exactly the overreach this check exists to prevent. The log directory itself counts,
  // since it is only ever in `removed` after `wroteLogs` proved Caroline wrote in it.
  const wroteHere = removed.some((path) => dirname(path) === directory && !symlinks.includes(path))
  const directoryEmpty =
    ownsDirectory &&
    entries !== null &&
    !isLink(directory) &&
    wroteHere &&
    failed.length === 0 &&
    leftBehind.length === 0

  let directoryRemoved = directoryEmpty
  if (directoryEmpty && !dryRun) {
    try {
      rmdirSync(directory)
    } catch (error) {
      // Reported rather than thrown, for the reason the file removals are: the files are already
      // gone, and a stack trace instead of the report is the one outcome this command must not have.
      directoryRemoved = false
      failed.push({ path: directory, message: reason(error) })
    }
  }

  return { directory, removed, symlinks, leftBehind, failed, directoryRemoved }
}

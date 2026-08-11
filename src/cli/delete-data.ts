/**
 * Deleting everything Caroline has: the database, its SQLite sidecars and the Google token file.
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
  ]
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
    const entry = lstatSync(path, { throwIfNoEntry: false })
    if (entry === undefined) continue

    // A directory carrying one of Caroline's names is not one of Caroline's files. `rmSync` without
    // `recursive` throws on it, which would abort the command partway through having deleted the
    // rest, and adding `recursive` would delete somebody's directory on the strength of its name.
    // It is left where it is, and the listing below reports it as what it is.
    if (entry.isDirectory()) continue

    // A symlink is removed as a link rather than followed, which is what `rmSync` does: pointing the
    // database at another disk is a reasonable thing to have done, and deleting the link is the most
    // this command may conclude from it. It is recorded as a link so the output can say so.
    if (entry.isSymbolicLink()) symlinks.push(path)

    if (!dryRun) {
      try {
        rmSync(path, { force: true })
      } catch (error) {
        // A read-only mount, a locked file, a permission the account does not have. The rest of the
        // files are still worth removing, and the report is the record of what happened: throwing
        // here would leave a partial deletion described by a stack trace.
        failed.push({ path, message: error instanceof Error ? error.message : String(error) })
        continue
      }
    }

    removed.push(path)
  }

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
  const ours = new Set([...(dryRun ? removed : []), ...failed.map((failure) => failure.path)])
  const leftBehind =
    ownsDirectory && existsSync(directory)
      ? readdirSync(directory)
          .map((entry) => join(directory, entry))
          .filter((path) => !ours.has(path))
          .toSorted()
      : []

  // `removed` having something in it is what says this directory was Caroline's. Without that check,
  // a `database.path` pointing into an empty directory of somebody's own has that directory deleted
  // by a command that had just reported finding nothing of Caroline's in it. A failure leaves a file
  // in place, so it stops the directory going too, by the same rule as anything else still in it.
  //
  // A symbolic link is not a directory Caroline created, whatever it points at, and `rmdirSync`
  // throws ENOTDIR on one. Symlinking the data directory onto another volume is the same reasonable
  // thing as symlinking the database, and the link is left where it is.
  const directoryIsLink = lstatSync(directory, { throwIfNoEntry: false })?.isSymbolicLink() === true
  const directoryEmpty =
    ownsDirectory &&
    !directoryIsLink &&
    removed.length > 0 &&
    failed.length === 0 &&
    leftBehind.length === 0 &&
    existsSync(directory)

  let directoryRemoved = directoryEmpty
  if (directoryEmpty && !dryRun) {
    try {
      rmdirSync(directory)
    } catch (error) {
      // Reported rather than thrown, for the reason the file removals are: the files are already
      // gone, and a stack trace instead of the report is the one outcome this command must not have.
      directoryRemoved = false
      failed.push({
        path: directory,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return { directory, removed, symlinks, leftBehind, failed, directoryRemoved }
}

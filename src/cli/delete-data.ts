/**
 * Deleting everything Caroline has: the database, its SQLite sidecars and the Google token file.
 * Spec 09 promises one documented command, and that nothing Caroline creates lives outside its
 * data directory. This is the half that decides what those files are and removes them; `delete.ts`
 * is the command that reports on it.
 *
 * The data directory is removed only when it is empty afterwards. Somebody may have pointed
 * `database.path` at a directory of their own, and a command that deleted a directory it did not
 * create would be a worse failure than one that leaves an empty folder behind.
 */
import { existsSync, lstatSync, readdirSync, rmSync, rmdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { Config } from '../config/schema.js'

/** Paths SQLite treats as something other than a file to create on disk. Mirrors `db/connection`. */
function isFilePath(path: string): boolean {
  return path !== ':memory:' && !path.startsWith('file:')
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
  ]
}

export interface DeletionReport {
  /** The data directory, which is where every path above lives. */
  readonly directory: string
  /** What was removed, or on a dry run what would be. */
  readonly removed: readonly string[]
  /** Anything else in the data directory. Not Caroline's, so not deleted, but said out loud. */
  readonly leftBehind: readonly string[]
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
    // this command may conclude from it.
    if (!dryRun) rmSync(path, { force: true })
    removed.push(path)
  }

  // A database that is not a file on disk (`:memory:`, or a `file:` URI) has no directory of
  // Caroline's making: `dirname` of it resolves to the working directory, and neither listing that
  // nor being one empty directory away from removing it is anything this command should do. The
  // token file is still removed above, which is the whole of what such an installation writes.
  const ownsDirectory = isFilePath(config.database.path)

  // Read after the removals, so what is reported is what is actually still there. On a dry run the
  // files that would have gone are subtracted instead, which is why this is the list of what was
  // removed rather than the list of Caroline's names: a directory that collided with one of those
  // names was not removed, and belongs in this list.
  const ours = new Set(dryRun ? removed : [])
  const leftBehind =
    ownsDirectory && existsSync(directory)
      ? readdirSync(directory)
          .map((entry) => join(directory, entry))
          .filter((path) => !ours.has(path))
          .toSorted()
      : []

  const directoryRemoved = ownsDirectory && leftBehind.length === 0 && existsSync(directory)
  if (directoryRemoved && !dryRun) rmdirSync(directory)

  return { directory, removed, leftBehind, directoryRemoved }
}

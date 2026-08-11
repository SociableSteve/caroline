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
import { existsSync, readdirSync, rmSync, rmdirSync } from 'node:fs'
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
  const database = isFilePath(config.database.path)
    ? resolve(config.database.path)
    : config.database.path
  const tokens = config.integrations.google.tokenPath

  return [
    ...(isFilePath(database)
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
  /** Caroline's own paths that were not there. A first run leaves most of these. */
  readonly missing: readonly string[]
  /** Anything else in the data directory. Not Caroline's, so not deleted, but said out loud. */
  readonly leftBehind: readonly string[]
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
  const missing: string[] = []

  for (const path of carolineDataPaths(config)) {
    if (!existsSync(path)) {
      missing.push(path)
      continue
    }

    if (!dryRun) rmSync(path, { force: true })
    removed.push(path)
  }

  // Read after the removals, so what is reported is what is actually still there. On a dry run
  // that includes Caroline's own files, which is why they are subtracted rather than listed.
  const ours = new Set(dryRun ? carolineDataPaths(config) : [])
  const leftBehind = existsSync(directory)
    ? readdirSync(directory)
        .map((entry) => join(directory, entry))
        .filter((path) => !ours.has(path))
        .toSorted()
    : []

  const directoryRemoved = !dryRun && leftBehind.length === 0 && existsSync(directory)
  if (directoryRemoved) rmdirSync(directory)

  return { directory, removed, missing, leftBehind, directoryRemoved }
}

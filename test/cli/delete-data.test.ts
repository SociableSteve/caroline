/**
 * The deletion command. Spec 09 promises a documented single command that removes everything
 * Caroline created, and criterion 10 is that it leaves no Caroline-created file on disk. The
 * assertion is therefore about the directory rather than about a list of names: a file added by
 * some later milestone and not added to the list would pass a test that checked the list.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { carolineDataPaths, deleteCarolineData } from '../../src/cli/delete-data.js'
import { loadConfig } from '../../src/config/load.js'
import type { Config } from '../../src/config/schema.js'
import { writeTokens } from '../../src/connectors/google/tokens.js'
import type { Database } from '../../src/db/index.js'
import { openCarolineDatabase } from '../../src/db/index.js'

const directories: string[] = []
const databases: Database[] = []

afterEach(() => {
  for (const database of databases.splice(0)) {
    try {
      database.close()
    } catch {
      // Already closed, or its file has been deleted underneath it. Either is fine here: the
      // point of the close is to release the handle, and a deleted file has released it.
    }
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** A data directory of this test's own, and the config that points Caroline at it. */
function temporaryConfig(): Config {
  const directory = mkdtempSync(join(tmpdir(), 'caroline-delete-'))
  directories.push(directory)

  return loadConfig({
    file: { database: { path: join(directory, 'caroline.db') } },
    env: {} as NodeJS.ProcessEnv,
  })
}

/** Everything a Caroline that has really run leaves behind: a migrated database and a connection. */
function runCaroline(config: Config): void {
  const database = openCarolineDatabase(config)
  databases.push(database)

  writeTokens(config.integrations.google.tokenPath, {
    refreshToken: 'refresh-token',
    accessToken: 'access-token',
    expiresAt: Date.now() + 3_600_000,
    scope: 'https://www.googleapis.com/auth/gmail.readonly',
    connectedAt: Date.now(),
  })
}

describe('carolineDataPaths', () => {
  it('names the database, its sidecars and the Google token file, all beside the database', () => {
    const config = temporaryConfig()
    const directory = dirname(config.database.path)

    expect(carolineDataPaths(config)).toEqual([
      join(directory, 'caroline.db'),
      join(directory, 'caroline.db-wal'),
      join(directory, 'caroline.db-shm'),
      join(directory, 'caroline.db-journal'),
      join(directory, 'google-tokens.json'),
      join(directory, 'google-tokens.json.tmp'),
    ])
  })
})

describe('deleteCarolineData', () => {
  it('leaves no Caroline-created file on disk, sidecars of a running database included', () => {
    const config = temporaryConfig()
    const directory = dirname(config.database.path)
    runCaroline(config)

    // Held open deliberately: SQLite removes its write-ahead log on a clean close, so the state
    // where a sidecar is still there is the state a crash or a kill leaves, which is exactly the
    // state somebody deleting their data is likely to be in.
    expect(existsSync(`${config.database.path}-wal`)).toBe(true)

    const report = deleteCarolineData(config)

    expect(report.leftBehind).toEqual([])
    expect(report.removed).toContain(config.database.path)
    expect(report.removed).toContain(config.integrations.google.tokenPath)
    expect(report.directoryRemoved).toBe(true)
    expect(existsSync(directory)).toBe(false)
  })

  it('removes nothing on a dry run, and says what it would have removed', () => {
    const config = temporaryConfig()
    runCaroline(config)

    const report = deleteCarolineData(config, { dryRun: true })

    expect(report.removed).toContain(config.database.path)
    expect(report.removed).toContain(config.integrations.google.tokenPath)
    // The directory going is part of what a real run would do, so the dry run says so rather than
    // leaving it to be a surprise afterwards.
    expect(report.directoryRemoved).toBe(true)
    expect(existsSync(config.database.path)).toBe(true)
    expect(existsSync(config.integrations.google.tokenPath)).toBe(true)
    expect(existsSync(dirname(config.database.path))).toBe(true)
  })

  it('does not say it would remove a directory holding somebody else’s file', () => {
    const config = temporaryConfig()
    runCaroline(config)
    writeFileSync(join(dirname(config.database.path), 'notes-of-my-own.txt'), 'mine\n')

    expect(deleteCarolineData(config, { dryRun: true }).directoryRemoved).toBe(false)
  })

  it('leaves a file Caroline did not create, and keeps the directory that holds it', () => {
    const config = temporaryConfig()
    const directory = dirname(config.database.path)
    runCaroline(config)

    const theirs = join(directory, 'notes-of-my-own.txt')
    writeFileSync(theirs, 'mine\n')

    const report = deleteCarolineData(config)

    expect(report.leftBehind).toEqual([theirs])
    expect(report.directoryRemoved).toBe(false)
    expect(existsSync(theirs)).toBe(true)
    expect(readdirSync(directory)).toEqual(['notes-of-my-own.txt'])
  })

  it('succeeds on a checkout that has never run, reporting nothing removed', () => {
    const config = temporaryConfig()
    const directory = dirname(config.database.path)
    rmSync(directory, { recursive: true, force: true })

    const report = deleteCarolineData(config)

    expect(report.removed).toEqual([])
    expect(report.leftBehind).toEqual([])
    expect(report.directoryRemoved).toBe(false)
  })

  it('recognises its own files through a relative database path, which is the default', () => {
    // `database.path` defaults to `./data/caroline.db`, and the report compares Caroline's paths
    // against what the directory listing gives back. Unresolved, `./data/caroline.db` and
    // `data/caroline.db` are the same file under two names, and a dry run reported the database as
    // a file Caroline had not written.
    // The real path, because a temporary directory reached through a symlink resolves to a
    // different absolute path than the one `mkdtemp` handed back, and this test is about resolution.
    const created = mkdtempSync(join(tmpdir(), 'caroline-delete-relative-'))
    directories.push(created)
    const directory = realpathSync(created)
    const cwd = process.cwd()
    process.chdir(directory)

    try {
      const config = loadConfig({
        file: { database: { path: './data/caroline.db' } },
        env: {} as NodeJS.ProcessEnv,
      })
      runCaroline(config)

      const report = deleteCarolineData(config, { dryRun: true })

      expect(report.leftBehind).toEqual([])
      expect(report.removed).toContain(join(directory, 'data', 'caroline.db'))
    } finally {
      process.chdir(cwd)
    }
  })

  it('leaves a directory that happens to carry one of its own names, in both modes', () => {
    const config = temporaryConfig()
    runCaroline(config)
    // A directory where the write-ahead log would be. `rmSync` without `recursive` throws on one,
    // which would abort the command having already deleted the database.
    const collision = `${config.database.path}-wal`
    rmSync(collision, { force: true })
    mkdirSync(collision)

    for (const dryRun of [true, false]) {
      const report = deleteCarolineData(config, { dryRun })

      expect(report.removed).not.toContain(collision)
      expect(report.leftBehind).toContain(collision)
      expect(report.directoryRemoved).toBe(false)
      expect(existsSync(collision)).toBe(true)
    }
  })

  it('removes only the token file for a database that is not a file on disk', () => {
    // `dirname(':memory:')` is the working directory, which Caroline did not create and must neither
    // list as leftovers nor be one empty directory away from removing.
    const created = mkdtempSync(join(tmpdir(), 'caroline-delete-memory-'))
    directories.push(created)
    const directory = realpathSync(created)
    const cwd = process.cwd()
    process.chdir(directory)

    try {
      const config = loadConfig({
        file: { database: { path: ':memory:' } },
        env: {} as NodeJS.ProcessEnv,
      })
      writeFileSync(join(directory, 'a-file-of-my-own.txt'), 'mine\n')
      writeTokens(config.integrations.google.tokenPath, {
        refreshToken: 'refresh-token',
        accessToken: null,
        expiresAt: null,
        scope: null,
        connectedAt: 0,
      })

      const report = deleteCarolineData(config)

      expect(report.removed).toEqual([config.integrations.google.tokenPath])
      expect(report.leftBehind).toEqual([])
      expect(report.directoryRemoved).toBe(false)
      expect(existsSync(directory)).toBe(true)
      expect(existsSync(join(directory, 'a-file-of-my-own.txt'))).toBe(true)
    } finally {
      process.chdir(cwd)
    }
  })

  it('keeps a data directory that is not empty of subdirectories', () => {
    const config = temporaryConfig()
    const directory = dirname(config.database.path)
    runCaroline(config)
    mkdirSync(join(directory, 'backups'))

    const report = deleteCarolineData(config)

    expect(report.leftBehind).toEqual([join(directory, 'backups')])
    expect(existsSync(join(directory, 'backups'))).toBe(true)
  })
})

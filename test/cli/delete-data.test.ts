/**
 * The deletion command. Spec 09 promises a documented single command that removes everything
 * Caroline created, and criterion 10 is that it leaves no Caroline-created file on disk. The
 * assertion is therefore about the directory rather than about a list of names: a file added by
 * some later milestone and not added to the list would pass a test that checked the list.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
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

  it('leaves an empty directory of somebody else’s that Caroline never wrote to', () => {
    // `database.path` may name a directory somebody keeps their own things in. Removing it for being
    // empty, having just reported finding nothing of Caroline's in it, is the failure the rule about
    // not deleting directories exists to prevent.
    const config = temporaryConfig()
    const directory = dirname(config.database.path)

    const report = deleteCarolineData(config)

    expect(report.removed).toEqual([])
    expect(report.directoryRemoved).toBe(false)
    expect(existsSync(directory)).toBe(true)
  })

  it('says a removed path was a link, and leaves what it pointed at', () => {
    const config = temporaryConfig()
    const directory = dirname(config.database.path)
    const elsewhere = join(directory, 'on-another-disk.db')
    writeFileSync(elsewhere, 'the real database\n')
    symlinkSync(elsewhere, config.database.path)

    const report = deleteCarolineData(config)

    expect(report.removed).toContain(config.database.path)
    expect(report.symlinks).toEqual([config.database.path])
    // The link went; the file it named did not, and is reported as a file Caroline did not write.
    expect(existsSync(config.database.path)).toBe(false)
    expect(existsSync(elsewhere)).toBe(true)
    expect(report.leftBehind).toContain(elsewhere)
  })

  it('reports a file it could not remove rather than throwing partway through', () => {
    const config = temporaryConfig()
    const directory = dirname(config.database.path)
    runCaroline(config)

    // Unlinking needs write permission on the directory, not on the file. Root ignores the mode, so
    // there is nothing to assert when the suite runs as root.
    if (process.getuid?.() === 0) return

    chmodSync(directory, 0o500)
    try {
      const report = deleteCarolineData(config)

      expect(report.removed).toEqual([])
      expect(report.failed.map((failure) => failure.path)).toContain(config.database.path)
      expect(report.failed[0]?.message).toMatch(/permission|EACCES/i)
      expect(existsSync(config.database.path)).toBe(true)
      // A file of Caroline's that would not go is not a file somebody else wrote, and saying so of a
      // token file would be a false statement about a live refresh token.
      expect(report.leftBehind).toEqual([])
      expect(report.directoryRemoved).toBe(false)
    } finally {
      chmodSync(directory, 0o700)
    }
  })

  it('leaves a data directory that is a symbolic link, and reports rather than throws', () => {
    // Symlinking the data directory onto another volume is the same reasonable thing as symlinking
    // the database. `rmdirSync` throws ENOTDIR on a link, which threw after the files had gone and
    // before the report was printed, so the deletion happened and nothing said what had.
    const created = mkdtempSync(join(tmpdir(), 'caroline-delete-link-'))
    directories.push(created)
    const elsewhere = join(created, 'on-another-volume')
    const linked = join(created, 'data')
    mkdirSync(elsewhere)
    symlinkSync(elsewhere, linked)

    const config = loadConfig({
      file: { database: { path: join(linked, 'caroline.db') } },
      env: {} as NodeJS.ProcessEnv,
    })
    runCaroline(config)

    const report = deleteCarolineData(config)

    expect(report.removed).toContain(config.database.path)
    expect(report.failed).toEqual([])
    expect(report.directoryRemoved).toBe(false)
    expect(existsSync(linked)).toBe(true)
    expect(readdirSync(elsewhere)).toEqual([])
  })

  it('reports rather than throws when a path cannot even be looked at', () => {
    // `throwIfNoEntry` suppresses "not there" and nothing else. A parent that is a file rather than a
    // directory makes `lstat` throw ENOTDIR, and that used to end the dry run in a stack trace: the
    // mode people are told to run first, on an ordinary typo in `database.path`.
    const directory = mkdtempSync(join(tmpdir(), 'caroline-delete-notdir-'))
    directories.push(directory)
    const notADirectory = join(directory, 'not-a-directory')
    writeFileSync(notADirectory, 'a file where a folder was expected\n')

    const config = loadConfig({
      file: { database: { path: join(notADirectory, 'caroline.db') } },
      env: {} as NodeJS.ProcessEnv,
    })

    for (const dryRun of [true, false]) {
      const report = deleteCarolineData(config, { dryRun })

      expect(report.removed).toEqual([])
      expect(report.failed.map((failure) => failure.message.slice(0, 6))).toContain('ENOTDI')
      expect(report.directoryRemoved).toBe(false)
    }
    expect(existsSync(notADirectory)).toBe(true)
  })

  it('reports rather than throws when the data directory cannot be listed', () => {
    const config = temporaryConfig()
    const directory = dirname(config.database.path)
    runCaroline(config)

    // Writable and searchable but not readable, so the files go and the listing afterwards fails.
    // Root ignores the mode, so there is nothing to assert when the suite runs as root.
    if (process.getuid?.() === 0) return

    chmodSync(directory, 0o300)
    try {
      const report = deleteCarolineData(config)

      expect(report.removed).toContain(config.database.path)
      expect(report.failed.map((failure) => failure.path)).toContain(directory)
      // The record of what went is the whole point of the command, and a directory it could not read
      // is no reason to lose it.
      expect(report.directoryRemoved).toBe(false)
    } finally {
      chmodSync(directory, 0o700)
    }
  })

  it('does not remove a directory whose only Caroline-shaped entry was a link somebody made', () => {
    // Unlinking a link somebody created is not evidence Caroline ever wrote in the directory, and the
    // documented rule is that the directory goes only if Caroline wrote something in it.
    const created = mkdtempSync(join(tmpdir(), 'caroline-delete-linkonly-'))
    directories.push(created)
    const elsewhere = join(created, 'elsewhere')
    const data = join(created, 'data')
    mkdirSync(elsewhere)
    mkdirSync(data)
    writeFileSync(join(elsewhere, 'real.db'), 'the real database\n')
    symlinkSync(join(elsewhere, 'real.db'), join(data, 'caroline.db'))

    const config = loadConfig({
      file: { database: { path: join(data, 'caroline.db') } },
      env: {} as NodeJS.ProcessEnv,
    })

    const report = deleteCarolineData(config)

    expect(report.removed).toEqual([join(data, 'caroline.db')])
    expect(report.symlinks).toEqual([join(data, 'caroline.db')])
    expect(report.directoryRemoved).toBe(false)
    expect(existsSync(data)).toBe(true)
    expect(existsSync(join(elsewhere, 'real.db'))).toBe(true)
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

/**
 * The log (spec 14). Deletion has to reach it, or spec 09's promise of one command that removes
 * everything stops being true the moment an instance has been running for a week. The log directory
 * is the one directory Caroline creates below the data directory, so it gets the same treatment the
 * data directory gets one level up: it goes when Caroline wrote in it and it is empty afterwards.
 */
describe('the log (spec 14 criterion 14, spec 09 criteria 10 and 28)', () => {
  /** What an instance that has been running leaves in its log directory. */
  function writeLogFiles(config: Config, names: readonly string[] = ['caroline.log']): string {
    const logs = join(dirname(config.database.path), 'logs')
    mkdirSync(logs, { recursive: true })
    for (const name of names) writeFileSync(join(logs, name), 'a line\n')
    return logs
  }

  it('names the log files it finds, alongside the database and the token file', () => {
    const config = temporaryConfig()
    const logs = writeLogFiles(config, ['caroline.log', 'caroline.log.1', 'caroline.log.2'])

    expect(carolineDataPaths(config)).toContain(join(logs, 'caroline.log'))
    expect(carolineDataPaths(config)).toContain(join(logs, 'caroline.log.1'))
    expect(carolineDataPaths(config)).toContain(join(logs, 'caroline.log.2'))
  })

  it('removes the log files, the log directory and then the data directory', () => {
    const config = temporaryConfig()
    const directory = dirname(config.database.path)
    runCaroline(config)
    const logs = writeLogFiles(config, ['caroline.log', 'caroline.log.1'])

    const report = deleteCarolineData(config)

    expect(report.removed).toContain(join(logs, 'caroline.log'))
    expect(report.removed).toContain(join(logs, 'caroline.log.1'))
    expect(report.removed).toContain(logs)
    expect(report.leftBehind).toEqual([])
    expect(report.failed).toEqual([])
    expect(report.directoryRemoved).toBe(true)
    expect(existsSync(directory)).toBe(false)
  })

  it('says it would remove them on a dry run, and removes nothing', () => {
    const config = temporaryConfig()
    runCaroline(config)
    const logs = writeLogFiles(config)

    const report = deleteCarolineData(config, { dryRun: true })

    expect(report.removed).toContain(join(logs, 'caroline.log'))
    expect(report.removed).toContain(logs)
    expect(report.directoryRemoved).toBe(true)
    expect(existsSync(join(logs, 'caroline.log'))).toBe(true)
    expect(existsSync(logs)).toBe(true)
  })

  it('keeps the log directory, and the data directory, when somebody else has a file in it', () => {
    const config = temporaryConfig()
    const directory = dirname(config.database.path)
    runCaroline(config)
    const logs = writeLogFiles(config)
    const theirs = join(logs, 'my-own-notes.txt')
    writeFileSync(theirs, 'mine\n')

    const report = deleteCarolineData(config)

    expect(report.removed).toContain(join(logs, 'caroline.log'))
    expect(report.removed).not.toContain(logs)
    expect(report.leftBehind).toEqual([theirs])
    expect(report.directoryRemoved).toBe(false)
    expect(existsSync(theirs)).toBe(true)
    expect(existsSync(directory)).toBe(true)
  })

  it('removes the files but not a log directory the user named somewhere of their own', () => {
    const directory = mkdtempSync(join(tmpdir(), 'caroline-delete-'))
    directories.push(directory)
    const elsewhere = mkdtempSync(join(tmpdir(), 'caroline-logs-'))
    directories.push(elsewhere)
    const config = loadConfig({
      file: {
        database: { path: join(directory, 'caroline.db') },
        logging: { file: { directory: elsewhere } },
      },
      env: {} as NodeJS.ProcessEnv,
    })
    runCaroline(config)
    writeFileSync(join(elsewhere, 'caroline.log'), 'a line\n')

    const report = deleteCarolineData(config)

    // The files are Caroline's wherever they are; the directory is the user's, and deleting one
    // they named would be the overreach this command refuses everywhere else.
    expect(report.removed).toContain(join(elsewhere, 'caroline.log'))
    expect(report.removed).not.toContain(elsewhere)
    expect(existsSync(elsewhere)).toBe(true)
    expect(readdirSync(elsewhere)).toEqual([])
  })

  it('leaves an empty log directory Caroline never wrote in, and says it is there', () => {
    const config = temporaryConfig()
    const directory = dirname(config.database.path)
    runCaroline(config)
    const logs = join(directory, 'logs')
    mkdirSync(logs)

    const report = deleteCarolineData(config)

    // Indistinguishable from a directory somebody made, so it is left and reported rather than
    // claimed. That also stops the data directory going while it is still in there.
    expect(report.removed).not.toContain(logs)
    expect(report.leftBehind).toEqual([logs])
    expect(report.directoryRemoved).toBe(false)
    expect(existsSync(logs)).toBe(true)
  })
})

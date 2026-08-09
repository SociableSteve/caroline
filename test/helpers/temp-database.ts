import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'
import { openDatabase, type Database } from '../../src/db/connection.js'
import { runMigrations } from '../../src/db/migrate.js'

const openDirectories: string[] = []
const openDatabases: Database[] = []

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close()
  for (const directory of openDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

/**
 * A real SQLite file in its own directory, closed and deleted after the test. Repository
 * tests run against the real schema through the real migration runner: the database is the
 * thing under test as much as the code is, so none of it is mocked.
 */
export function temporaryDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'caroline-test-'))
  openDirectories.push(directory)
  return join(directory, 'caroline.db')
}

/** An open, unmigrated database. For tests of the migration runner itself. */
export function emptyDatabase(): Database {
  const database = openDatabase(temporaryDatabasePath())
  openDatabases.push(database)
  return database
}

/** An open database with every migration applied. The normal starting point. */
export function migratedDatabase(): Database {
  const database = emptyDatabase()
  runMigrations(database)
  return database
}

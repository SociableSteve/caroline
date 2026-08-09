import type { Config } from '../config/schema.js'
import { openDatabase, type Database } from './connection.js'
import { runMigrations } from './migrate.js'

export type { Database } from './connection.js'

/**
 * The one way the process gets a database: open the configured file, creating it and its
 * directory if this is a first run, then bring the schema up to date. Migrations are
 * idempotent, so this is safe on every startup and does nothing on all but the first.
 * Spec 01, criterion 7.
 */
export function openCarolineDatabase(config: Config): Database {
  const database = openDatabase(config.database.path)
  runMigrations(database)
  return database
}

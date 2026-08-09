import { withTransaction, type Database } from './connection.js'
import { migrations as shippedMigrations } from './migrations/index.js'

export interface Migration {
  /** Unique and ascending. The runner applies them in this order and never re-applies. */
  readonly id: number
  readonly name: string
  up(database: Database): void
}

export interface MigrationResult {
  /** Ids applied by this run. Empty on every startup after the first. */
  readonly applied: readonly number[]
}

function ensureLedger(database: Database): void {
  database.exec(`
    create table if not exists schema_migrations (
      id integer primary key,
      name text not null,
      applied_at integer not null
    )
  `)
}

export function appliedMigrationIds(database: Database): number[] {
  ensureLedger(database)
  return database
    .prepare('select id from schema_migrations order by id')
    .all()
    .map((row) => Number((row as { id: unknown }).id))
}

function assertIdsAreUnique(migrations: readonly Migration[]): void {
  const seen = new Set<number>()
  for (const migration of migrations) {
    if (seen.has(migration.id)) {
      throw new Error(
        `duplicate migration id ${migration.id} ("${migration.name}"): ids must be unique, or one of the two would never run`,
      )
    }
    seen.add(migration.id)
  }
}

/**
 * Applies every migration the database has not seen, in id order, each in its own
 * transaction. Idempotent: safe to call on every startup, which is exactly when it runs.
 * A failure rolls that migration back and stops, so the schema is never half-applied.
 * Spec 01, criterion 7.
 */
export function runMigrations(
  database: Database,
  migrations: readonly Migration[] = shippedMigrations,
): MigrationResult {
  assertIdsAreUnique(migrations)
  ensureLedger(database)

  const already = new Set(appliedMigrationIds(database))
  const pending = migrations
    .filter((migration) => !already.has(migration.id))
    .toSorted((left, right) => left.id - right.id)

  const record = database.prepare(
    'insert into schema_migrations (id, name, applied_at) values (?, ?, ?)',
  )
  const applied: number[] = []

  for (const migration of pending) {
    try {
      withTransaction(database, () => {
        migration.up(database)
        record.run(migration.id, migration.name, Date.now())
      })
    } catch (error) {
      // The reason goes in the message, not only in `cause`: this surfaces at startup,
      // where an operator sees one line and needs it to say what actually broke.
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`migration ${migration.id} (${migration.name}) failed: ${reason}`, {
        cause: error,
      })
    }
    applied.push(migration.id)
  }

  return { applied }
}

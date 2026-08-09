import type { Database } from '../connection.js'
import type { Row } from '../rows.js'
import type { SourceProvider } from '../../domain/source.js'

/**
 * The `since` cursor spec 02 asks be persisted per connector, so an incremental fetch can
 * pick up where the last successful run left off. A connector whose provider cannot do an
 * incremental fetch is handed the cursor anyway and is free to ignore it; the engine does
 * not need to know which is which.
 *
 * Only a successful run advances it. A failed run leaves the cursor where it was, so the
 * next attempt covers the window the failure lost.
 */
export function getSyncCursor(database: Database, provider: SourceProvider): number | null {
  const row = database.prepare('select cursor from sync_state where provider = ?').get(provider)
  if (row === undefined) return null

  const cursor = (row as Row).cursor
  return cursor === null || cursor === undefined ? null : Number(cursor)
}

export function setSyncCursor(
  database: Database,
  provider: SourceProvider,
  cursor: number,
  now: number,
): void {
  database
    .prepare(
      `insert into sync_state (provider, cursor, updated_at) values (?, ?, ?)
       on conflict (provider) do update set cursor = excluded.cursor,
         updated_at = excluded.updated_at`,
    )
    .run(provider, cursor, now)
}

import type { Migration } from '../migrate.js'

/**
 * Backfills `mcp_sessions.accumulator_version` for a database that ran migration 12 before it
 * was amended to include that column. Spec 12.
 *
 * Migration 12 originally shipped `mcp_sessions` without `accumulator_version`, then gained
 * the column in review before it reached anyone. The migration runner tracks what it has
 * applied by id alone (`migrate.ts`), so a database that already ran the pre-amendment id 12
 * has that id recorded forever and never re-runs it, no matter how its code changes afterwards.
 * `src/db/repositories/mcp.ts` reads and writes `accumulator_version` unconditionally, so a
 * database in that state fails every MCP tool call with "no such column: accumulator_version".
 *
 * This migration adds the column, but only where it is actually missing: on any database
 * created after the amendment, migration 12 (as it now reads) already created the column, and
 * SQLite's `alter table add column` fails outright if the column already exists. So the
 * column is checked for with `pragma table_info` first, exactly as `alter table add column`
 * would need it, and the `alter table` only runs when it is genuinely absent. Existing rows
 * get `0`, the same default migration 12 declares, so a bumped or compared version behaves for
 * a backfilled row exactly as it would have from the start.
 */
export const mcpAccumulatorVersion: Migration = {
  id: 14,
  name: 'mcp-accumulator-version',
  up(database) {
    const columns = database.prepare("pragma table_info('mcp_sessions')").all() as Array<{
      name: unknown
    }>
    const hasAccumulatorVersion = columns.some((column) => column.name === 'accumulator_version')

    if (!hasAccumulatorVersion) {
      database.exec(
        'alter table mcp_sessions add column accumulator_version integer not null default 0',
      )
    }
  },
}

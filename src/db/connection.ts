import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * The database handle. `node:sqlite` is a Node built-in, so nothing here needs a compiler
 * at install time. Synchronous throughout, which suits a single-user process: there is no
 * concurrency to lose and no callback colour to spread through the repositories.
 */
export type Database = DatabaseSync

/** Paths SQLite treats as something other than a file to create on disk. */
function isFilePath(path: string): boolean {
  return path !== ':memory:' && !path.startsWith('file:')
}

export function openDatabase(path: string): Database {
  if (isFilePath(path)) mkdirSync(dirname(path), { recursive: true })

  const database = new DatabaseSync(path)

  // WAL keeps the scheduler's writes from blocking a page load. `foreign_keys` is off by
  // default in SQLite and has to be set per connection, which is what makes a project
  // delete orphan its tasks instead of failing.
  database.exec('pragma journal_mode = WAL')
  database.exec('pragma foreign_keys = ON')
  database.exec('pragma busy_timeout = 5000')

  return database
}

/**
 * How deep into nested `withTransaction` calls each handle is. SQLite has no nested
 * transactions, so the inner levels are savepoints, and the depth is what names them.
 * Keyed on the handle rather than held in a module variable, so two open databases cannot
 * confuse each other's nesting.
 */
const transactionDepth = new WeakMap<Database, number>()

/**
 * Runs `work` in a transaction, rolling back if it throws. `node:sqlite` has no
 * `transaction()` helper of its own, and every write path here wants one.
 *
 * Nesting is expected rather than merely tolerated: a repository function wraps its own
 * multi-statement write, and a route composes several of those into one unit. The outermost
 * call is the real transaction and the inner ones are savepoints, so an inner failure can be
 * caught and handled without discarding the work around it, while a failure that reaches the
 * top rolls back everything.
 */
export function withTransaction<T>(database: Database, work: () => T): T {
  const depth = transactionDepth.get(database) ?? 0
  const savepoint = `caroline_${depth}`
  const begin = depth === 0 ? 'begin' : `savepoint ${savepoint}`
  const commit = depth === 0 ? 'commit' : `release ${savepoint}`
  const rollback = depth === 0 ? 'rollback' : `rollback to ${savepoint}`

  database.exec(begin)
  transactionDepth.set(database, depth + 1)

  try {
    const result = work()
    database.exec(commit)
    return result
  } catch (error) {
    // SQLite aborts the transaction itself on errors such as SQLITE_FULL, which leaves
    // nothing to roll back and makes this throw. The original failure is the useful one.
    try {
      database.exec(rollback)
    } catch {
      // Ignored deliberately: see above.
    }
    throw error
  } finally {
    transactionDepth.set(database, depth)
  }
}

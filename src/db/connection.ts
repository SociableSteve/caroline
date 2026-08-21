import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * The database handle. `node:sqlite` is a Node built-in, so nothing here needs a compiler
 * at install time. Synchronous throughout, which suits a single-user process: there is no
 * concurrency to lose and no callback colour to spread through the repositories.
 */
export type Database = DatabaseSync

/**
 * Paths SQLite treats as something other than a file to create on disk. Exported because the
 * deletion command has to draw the same line, and two copies of this predicate would let a path
 * that opens no file be deleted as though it had one.
 */
export function isFilePath(path: string): boolean {
  return path !== ':memory:' && !path.startsWith('file:')
}

/**
 * Owner only, on the directory and on the file. Spec 09 says filesystem permissions are the only
 * protection this data has at rest, which makes these two numbers the whole of that protection:
 * the database holds every task, note and stored body Caroline has, and a default umask leaves a
 * newly created file world-readable, so anybody else with an account on the machine could read
 * the lot. Named the way `src/connectors/google/tokens.ts` names its own mode, which has been
 * 0600 since it was written, for the same reason and with the same intent.
 */
const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600

/**
 * The files SQLite keeps beside the database in WAL mode. They hold committed and in-flight page
 * data, so a world-readable sidecar leaks the same content the database does, and tightening only
 * the database would be protection in name only. They do not exist until the first write, so an
 * absent one is the normal state of a database that has just been created rather than a failure.
 */
const sidecarSuffixes = ['-wal', '-shm'] as const

/**
 * The `chmod` failures that are a fact about the filesystem rather than a fault. Each of them
 * means the mode cannot be carried where this database lives: a CIFS or exFAT mount, or a
 * container volume, answers `EPERM`, `ENOTSUP`, `EOPNOTSUPP`, `EINVAL` or `ENOSYS` depending on
 * the driver, a read-only mount answers `EROFS`, and a file owned by another account answers
 * `EPERM` or `EACCES`. `CAROLINE_DB_PATH` pointing at such a mount is an ordinary self-hosted
 * arrangement, and these modes are defence in depth over a machine spec 09 already says has one
 * user: a filesystem that cannot express them is a weaker posture, not a reason to refuse to
 * start. Anything else, `EIO` above all, means the storage itself is misbehaving and is still
 * thrown.
 */
const tolerableModeFailures: ReadonlySet<string> = new Set([
  'EPERM',
  'EACCES',
  'ENOTSUP',
  'EOPNOTSUPP',
  'EINVAL',
  'ENOSYS',
  'EROFS',
])

/** A mode this process wanted to set and the filesystem would not carry, for the one line
 * `openDatabase` writes about them. */
interface ModeFailure {
  readonly path: string
  readonly code: string
}

/**
 * Applies a mode, tolerating a file that is not there and a filesystem that cannot express it.
 * `chmod` is done after opening rather than through a creation mode, because SQLite creates these
 * files itself and a creation mode is masked by the umask in any case: `tokens.ts` sets a mode at
 * creation and again afterwards for exactly that reason. An existing database with a wider mode is
 * tightened, which is the point: every install that has run before this change has one.
 *
 * An absent file is silent rather than reported: the WAL sidecars do not exist until the first
 * write, so their absence is the normal state of a database that has just been created.
 */
function applyModeIfPossible(path: string, mode: number): ModeFailure | null {
  try {
    chmodSync(path, mode)
    return null
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    if (code === undefined || !tolerableModeFailures.has(code)) throw error
    return { path, code }
  }
}

export function openDatabase(path: string): Database {
  // `mkdirSync` answers with the first directory it created, or nothing where they all existed
  // already, and that is exactly the line to draw for the `chmod` below.
  const created = isFilePath(path)
    ? mkdirSync(dirname(path), { recursive: true, mode: DIRECTORY_MODE })
    : undefined

  const database = new DatabaseSync(path)

  // WAL keeps the scheduler's writes from blocking a page load. `foreign_keys` is off by
  // default in SQLite and has to be set per connection, which is what makes a project
  // delete orphan its tasks instead of failing.
  database.exec('pragma journal_mode = WAL')
  database.exec('pragma foreign_keys = ON')
  database.exec('pragma busy_timeout = 5000')

  if (isFilePath(path)) {
    // The directory too, and again after `mkdirSync` rather than only through its `mode`, which
    // the umask masks. Only a directory this call created, though: `database.path` may point
    // somewhere of the user's own, and narrowing a directory Caroline did not make would be the
    // same overreach the deletion command refuses for the same reason (spec 09, "It deletes its
    // own files, not a directory").
    const failures = [
      ...(created === undefined ? [] : [applyModeIfPossible(created, DIRECTORY_MODE)]),
      applyModeIfPossible(path, FILE_MODE),
      ...sidecarSuffixes.map((suffix) => applyModeIfPossible(`${path}${suffix}`, FILE_MODE)),
    ].filter((failure): failure is ModeFailure => failure !== null)

    // One line for the whole open rather than one per path. On a mount that cannot carry these
    // modes every one of them fails, and four lines saying the same thing on every start is a
    // warning an operator learns to scroll past. Written to stderr because this runs before the
    // server, and its logger, exists: `src/server/main.ts` reports a configuration failure the
    // same way.
    if (failures.length > 0) {
      const described = failures.map(({ path: at, code }) => `${at} (${code})`).join(', ')
      process.stderr.write(
        `Caroline could not set owner-only permissions on ${described}. The filesystem this database lives on cannot carry them, so anybody with an account on this machine may be able to read it. Caroline is starting anyway.\n`,
      )
    }
  }

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
  // `rollback to` reverts the work but leaves the savepoint on SQLite's stack, so a nested
  // rollback releases it too. Without that, every caught nested failure inside one long outer
  // transaction leaves an entry behind and the depth counter and the stack drift apart.
  const rollback = depth === 0 ? 'rollback' : `rollback to ${savepoint}; release ${savepoint}`

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

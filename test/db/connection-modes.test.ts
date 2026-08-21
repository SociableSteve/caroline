/**
 * What `openDatabase` does when the filesystem cannot express the modes it wants. Spec 09
 * criterion 25: the 0700 and 0600 modes are defence in depth over a single-user machine, so a
 * filesystem that cannot express them is a weaker posture and not a reason to refuse to run.
 * `CAROLINE_DB_PATH` pointing at a CIFS or exFAT mount, or at a container volume, is an ordinary
 * self-hosted arrangement, and `chmod` there answers `EPERM`, `ENOTSUP` or `EROFS` rather than
 * succeeding. A file owned by another account answers `EPERM` too.
 *
 * `chmodSync` is mocked rather than a real unsupported mount arranged, because there is no way to
 * make a POSIX filesystem refuse a `chmod` from the account that owns the file, and the thing
 * under test is what this module does with the error rather than which filesystems produce it.
 * Kept in a file of its own for the same reason: the mock is per-file, and the permission tests in
 * `connection.test.ts` are about the real modes real filesystems really end up with.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFs from 'node:fs'

/** The code the next `chmodSync` fails with, or null to let it through to the real one. */
const { chmodFailure } = vi.hoisted(() => ({ chmodFailure: { code: null as string | null } }))

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof NodeFs>('node:fs')
  return {
    ...actual,
    chmodSync: (path: string, mode: number): void => {
      if (chmodFailure.code === null) {
        actual.chmodSync(path, mode)
        return
      }
      const error: NodeJS.ErrnoException = new Error(
        `chmod failed for ${String(path)}: ${chmodFailure.code}`,
      )
      error.code = chmodFailure.code
      throw error
    },
  }
})

const { openDatabase } = await import('../../src/db/connection.js')

describe('openDatabase where the filesystem cannot express a mode', () => {
  let directory = ''
  let warnings: string[] = []

  beforeEach(() => {
    directory = join(mkdtempSync(join(tmpdir(), 'caroline-modes-unsupported-')), 'data')
    warnings = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown): boolean => {
      warnings.push(String(chunk))
      return true
    })
  })

  afterEach(() => {
    chmodFailure.code = null
    vi.restoreAllMocks()
    rmSync(directory, { recursive: true, force: true })
  })

  it.each(['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP', 'EROFS', 'EINVAL', 'ENOSYS'])(
    'opens the database anyway when chmod answers %s, and says so once',
    (code) => {
      chmodFailure.code = code

      const database = openDatabase(join(directory, 'caroline.db'))

      expect(database.prepare('select 1 as one').get()).toMatchObject({ one: 1 })
      database.close()

      // One line for the whole open, not one per file: the directory, the database and both
      // sidecars fail together on such a mount, and four lines saying the same thing on every
      // start is noise an operator learns to ignore.
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain(code)
      expect(warnings[0]).toContain('caroline.db')
    },
  )

  it('still fails on a code that means something genuinely unexpected', () => {
    // The tolerated codes all mean "this filesystem or this file cannot carry that mode". An I/O
    // error means the storage is failing, and opening a database on failing storage and saying
    // nothing would be the worse answer.
    chmodFailure.code = 'EIO'

    expect(() => openDatabase(join(directory, 'caroline.db'))).toThrow('EIO')
  })
})

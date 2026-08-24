/**
 * The rotating sink, against a real temporary directory. Spec 14, criteria 3 to 7: the boundary,
 * the cascade, the two bounds, and the two ways it can be told it cannot write.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Writable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config/load.js'
import { createLogDestination, logDirectory } from '../../src/server/log-destination.js'
import { isLogFileName, LOG_FILE_NAME, openLogFile } from '../../src/server/log-file.js'

const directories: string[] = []

function temporaryDirectory(): string {
  const created = mkdtempSync(join(tmpdir(), 'caroline-log-'))
  directories.push(created)
  return created
}

afterEach(() => {
  // Left in place deliberately on a failure would be nice, but a suite that fills the temporary
  // directory is worse: the assertions read the files while they are still there.
  for (const directory of directories.splice(0)) {
    try {
      chmodSync(directory, 0o700)
    } catch {
      // Only the read-only case needs this, and only so the files inside can be removed.
    }
  }
})

const line = (text: string): string => `${text}\n`

describe('the log file rotates at its boundary (spec 14 criterion 3)', () => {
  it('starts a new file rather than splitting a line across two', () => {
    const directory = temporaryDirectory()
    const file = openLogFile({ directory, maxBytes: 32, maxFiles: 5, retainDays: 14 })

    file.write(line('a'.repeat(20)))
    file.write(line('b'.repeat(20)))
    file.close()

    const rotated = readFileSync(join(directory, `${LOG_FILE_NAME}.1`), 'utf8')
    const live = readFileSync(join(directory, LOG_FILE_NAME), 'utf8')

    expect(rotated).toBe(line('a'.repeat(20)))
    expect(live).toBe(line('b'.repeat(20)))
  })

  it('writes a line longer than the cap whole, in a file of its own', () => {
    const directory = temporaryDirectory()
    const file = openLogFile({ directory, maxBytes: 4096, maxFiles: 5, retainDays: 14 })

    file.write(line('a'))
    file.write(line('b'.repeat(8192)))
    file.close()

    expect(readFileSync(join(directory, LOG_FILE_NAME), 'utf8')).toBe(line('b'.repeat(8192)))
    expect(readFileSync(join(directory, `${LOG_FILE_NAME}.1`), 'utf8')).toBe(line('a'))
  })

  it('cascades the renames, so the oldest line is in the highest-numbered file', () => {
    const directory = temporaryDirectory()
    const file = openLogFile({ directory, maxBytes: 8, maxFiles: 4, retainDays: 14 })

    for (const text of ['first', 'second', 'third', 'fourth']) file.write(line(text))
    file.close()

    expect(readFileSync(join(directory, LOG_FILE_NAME), 'utf8')).toBe(line('fourth'))
    expect(readFileSync(join(directory, `${LOG_FILE_NAME}.1`), 'utf8')).toBe(line('third'))
    expect(readFileSync(join(directory, `${LOG_FILE_NAME}.2`), 'utf8')).toBe(line('second'))
    expect(readFileSync(join(directory, `${LOG_FILE_NAME}.3`), 'utf8')).toBe(line('first'))
  })
})

describe('the total is bounded (spec 14 criterion 4)', () => {
  it('keeps no more than maxFiles files however many lines are written', () => {
    const directory = temporaryDirectory()
    const maxFiles = 3
    const maxBytes = 64
    const file = openLogFile({ directory, maxBytes, maxFiles, retainDays: 14 })

    // Many times the whole bound, so the assertion is about the ceiling rather than about how many
    // rotations happened to fit.
    for (let written = 0; written < 500; written += 1)
      file.write(line(`line ${written} `.repeat(4)))
    file.close()

    const files = readdirSync(directory)
    expect(files).toHaveLength(maxFiles)
    expect(files.every(isLogFileName)).toBe(true)

    const total = files.reduce((sum, name) => sum + statSync(join(directory, name)).size, 0)
    // Each file is closed at most one line past the cap, which is the cost of never splitting a
    // line. The bound is therefore the cap times the count plus one line, not less than the cap.
    expect(total).toBeLessThan(maxBytes * maxFiles + 200)
  })

  it('keeps only the live file when maxFiles is one', () => {
    const directory = temporaryDirectory()
    const file = openLogFile({ directory, maxBytes: 8, maxFiles: 1, retainDays: 14 })

    file.write(line('first'))
    file.write(line('second'))
    file.close()

    expect(readdirSync(directory)).toEqual([LOG_FILE_NAME])
    expect(readFileSync(join(directory, LOG_FILE_NAME), 'utf8')).toBe(line('second'))
  })
})

describe('the day bound (spec 14 criterion 5)', () => {
  it('removes a rotated file older than retainDays at open, and never the live one', () => {
    const directory = temporaryDirectory()
    const stale = join(directory, `${LOG_FILE_NAME}.1`)
    const fresh = join(directory, `${LOG_FILE_NAME}.2`)
    writeFileSync(stale, line('old'))
    writeFileSync(fresh, line('recent'))
    writeFileSync(join(directory, LOG_FILE_NAME), line('live'))

    const ancient = (Date.now() - 30 * 86_400_000) / 1000
    utimesSync(stale, ancient, ancient)

    // At open: an instance restarted after a long absence brings what it finds into the bound.
    const file = openLogFile({ directory, maxBytes: 4096, maxFiles: 5, retainDays: 14 })
    file.close()

    expect(existsSync(stale)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
    expect(readFileSync(join(directory, LOG_FILE_NAME), 'utf8')).toBe(line('live'))
  })

  it('leaves a live file alone however old it is', () => {
    const directory = temporaryDirectory()
    const live = join(directory, LOG_FILE_NAME)
    writeFileSync(live, line('quiet instance'))
    const ancient = (Date.now() - 400 * 86_400_000) / 1000
    utimesSync(live, ancient, ancient)

    const file = openLogFile({ directory, maxBytes: 4096, maxFiles: 5, retainDays: 14 })
    file.write(line('still here'))
    file.close()

    expect(readFileSync(live, 'utf8')).toContain('quiet instance')
  })

  it('ages a rotated file out on a write once the interval has passed', () => {
    const directory = temporaryDirectory()
    const stale = join(directory, `${LOG_FILE_NAME}.1`)
    writeFileSync(stale, line('old'))
    const ancient = (Date.now() - 30 * 86_400_000) / 1000
    utimesSync(stale, ancient, ancient)

    // A clock that starts before the file is stale enough to prune, so the pass at open keeps it and
    // only the throttled pass on a later write removes it.
    let clock = Date.now() - 30 * 86_400_000
    const file = openLogFile({
      directory,
      maxBytes: 4096,
      maxFiles: 5,
      retainDays: 14,
      now: () => clock,
    })

    file.write(line('first'))
    expect(existsSync(stale)).toBe(true)

    clock = Date.now()
    file.write(line('an hour and a month later'))
    file.close()

    expect(existsSync(stale)).toBe(false)
  })

  it('applies a lowered maxFiles to rotations the old bound allowed', () => {
    const directory = temporaryDirectory()
    for (const index of [1, 2, 3, 4, 5]) {
      writeFileSync(join(directory, `${LOG_FILE_NAME}.${index}`), line(`rotation ${index}`))
    }

    const file = openLogFile({ directory, maxBytes: 4096, maxFiles: 3, retainDays: 365 })
    file.close()

    expect(readdirSync(directory).toSorted()).toEqual([
      LOG_FILE_NAME,
      `${LOG_FILE_NAME}.1`,
      `${LOG_FILE_NAME}.2`,
    ])
  })
})

describe('a file it cannot write (spec 14 criterion 6)', () => {
  it('says so once, naming the path, and keeps no file', () => {
    const parent = temporaryDirectory()
    chmodSync(parent, 0o500)
    const directory = join(parent, 'logs')
    const problems: string[] = []

    const file = openLogFile({
      directory,
      maxBytes: 4096,
      maxFiles: 5,
      retainDays: 14,
      onProblem: (message) => problems.push(message),
    })

    file.write(line('this goes nowhere'))
    file.write(line('nor does this'))
    file.close()

    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain(join(directory, LOG_FILE_NAME))
    expect(problems[0]).toContain('Logging continues on stdout only')
    expect(file.path).toBeNull()
    expect(existsSync(directory)).toBe(false)
  })

  it('creates the directory owner-only, and the file with it', () => {
    const parent = temporaryDirectory()
    const directory = join(parent, 'logs')
    const file = openLogFile({ directory, maxBytes: 4096, maxFiles: 5, retainDays: 14 })
    file.write(line('a line'))
    file.close()

    // Spec 09's modes, for spec 09's reason: filesystem permissions are the whole of the protection.
    expect(statSync(directory).mode & 0o777).toBe(0o700)
    expect(statSync(join(directory, LOG_FILE_NAME)).mode & 0o777).toBe(0o600)
  })

  it('tightens a log file that was already there with a wider mode', () => {
    const directory = temporaryDirectory()
    // Every install that ran before this change has one, and a `logging.file.directory` somebody
    // named may hold one written under a default umask. A creation mode does nothing for either:
    // it is masked by the umask, and it is not consulted at all for a file that exists.
    writeFileSync(join(directory, LOG_FILE_NAME), line('from the last run'), { mode: 0o644 })
    chmodSync(join(directory, LOG_FILE_NAME), 0o644)

    const file = openLogFile({ directory, maxBytes: 4096, maxFiles: 5, retainDays: 14 })
    file.write(line('from this one'))
    file.close()

    expect(statSync(join(directory, LOG_FILE_NAME)).mode & 0o777).toBe(0o600)
  })

  it('tightens the file it opens after a rotation too', () => {
    const directory = temporaryDirectory()
    const file = openLogFile({ directory, maxBytes: 16, maxFiles: 3, retainDays: 14 })

    file.write(line('a'.repeat(12)))
    file.write(line('b'.repeat(12)))
    file.close()

    expect(statSync(join(directory, LOG_FILE_NAME)).mode & 0o777).toBe(0o600)
    expect(statSync(join(directory, `${LOG_FILE_NAME}.1`)).mode & 0o777).toBe(0o600)
  })

  it('leaves a directory it did not create as it found it, and still tightens the file', () => {
    // The rule `src/db/connection.ts` follows and the deletion command follows: narrowing a
    // directory Caroline did not make is the same overreach as removing one.
    const directory = temporaryDirectory()
    chmodSync(directory, 0o755)

    const file = openLogFile({ directory, maxBytes: 4096, maxFiles: 5, retainDays: 14 })
    file.write(line('a line'))
    file.close()

    expect(statSync(directory).mode & 0o777).toBe(0o755)
    expect(statSync(join(directory, LOG_FILE_NAME)).mode & 0o777).toBe(0o600)
  })
})

describe('where the log lives (spec 14 criterion 13)', () => {
  it('defaults to a logs directory beside the database, wherever that is', () => {
    const elsewhere = temporaryDirectory()
    const config = loadConfig({
      file: { database: { path: join(elsewhere, 'somewhere', 'caroline.db') } },
      env: {} as NodeJS.ProcessEnv,
    })

    // Beside the database rather than beside the default `data`, which is what keeps spec 09's
    // promise that nothing Caroline creates lives outside its data directory.
    expect(logDirectory(config)).toBe(join(elsewhere, 'somewhere', 'logs'))
  })

  it('follows a directory that is configured, resolved to an absolute path', () => {
    const config = loadConfig({
      file: { logging: { file: { directory: './somewhere/else' } } },
      env: {} as NodeJS.ProcessEnv,
    })

    expect(logDirectory(config)).toBe(resolve('./somewhere/else'))
  })

  it('writes nothing at all with the file turned off', () => {
    const directory = temporaryDirectory()
    const config = loadConfig({
      file: { logging: { file: { enabled: false, directory } } },
      env: {} as NodeJS.ProcessEnv,
    })
    const destination = createLogDestination({ config, stdout: new Writable({ write() {} }) })

    destination.stream.write('a line\n')
    destination.close()

    expect(destination.path).toBeNull()
    expect(readdirSync(directory)).toEqual([])
  })
})

describe('what the sink claims as its own', () => {
  it('recognises the live file and its rotations, and nothing else', () => {
    expect(isLogFileName(LOG_FILE_NAME)).toBe(true)
    expect(isLogFileName(`${LOG_FILE_NAME}.1`)).toBe(true)
    expect(isLogFileName(`${LOG_FILE_NAME}.42`)).toBe(true)
    expect(isLogFileName(`${LOG_FILE_NAME}.0`)).toBe(false)
    expect(isLogFileName('caroline.db')).toBe(false)
    expect(isLogFileName('caroline.log.old')).toBe(false)
    expect(isLogFileName('notes.txt')).toBe(false)
  })

  it('appends to a file that is already there rather than truncating it', () => {
    const directory = temporaryDirectory()
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, LOG_FILE_NAME), line('from the last run'))

    const file = openLogFile({ directory, maxBytes: 4096, maxFiles: 5, retainDays: 14 })
    file.write(line('from this one'))
    file.close()

    expect(readFileSync(join(directory, LOG_FILE_NAME), 'utf8')).toBe(
      `${line('from the last run')}${line('from this one')}`,
    )
  })
})

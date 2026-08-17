/**
 * The command around the deletion. The property worth a test is the gate: what somebody typing the
 * command without having read it gets is a listing, and their database is still there afterwards.
 */
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runDeleteCommand, usage } from '../../src/cli/delete-command.js'
import { openCarolineDatabase } from '../../src/db/index.js'
import { loadConfig } from '../../src/config/load.js'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

interface Run {
  readonly code: number
  readonly out: string
  readonly err: string
  readonly databasePath: string
}

/**
 * A data directory with a real migrated database in it, a config file naming it, and the command run
 * against both through the environment, exactly as the npm script reaches them.
 */
function run(argv: readonly string[]): Run {
  const directory = mkdtempSync(join(tmpdir(), 'caroline-delete-command-'))
  directories.push(directory)

  const databasePath = join(directory, 'data', 'caroline.db')
  const configPath = join(directory, 'caroline.config.json')
  writeFileSync(configPath, JSON.stringify({ database: { path: databasePath } }))

  const env = { CAROLINE_CONFIG: configPath } as NodeJS.ProcessEnv
  openCarolineDatabase(loadConfig({ file: { database: { path: databasePath } }, env })).close()

  let out = ''
  let err = ''
  const code = runDeleteCommand(argv, {
    stdout: (text) => (out += text),
    stderr: (text) => (err += text),
    env,
  })

  return { code, out, err, databasePath }
}

describe('runDeleteCommand', () => {
  it('deletes nothing without --yes, and says how to mean it', () => {
    const { code, out, databasePath } = run([])

    expect(code).toBe(0)
    expect(out).toContain('Would remove:')
    expect(out).toContain(databasePath)
    expect(out).toContain('npm run delete-data -- --yes')
    // Including the directory, which a real run takes with it. Anything the command does and does
    // not list is a thing the dry run failed to warn about.
    expect(out).toContain('Would remove the empty')
    expect(existsSync(databasePath)).toBe(true)
  })

  it('deletes with --yes, and says what went', () => {
    const { code, out, databasePath } = run(['--yes'])

    expect(code).toBe(0)
    expect(out).toContain('Removed:')
    expect(out).toContain(databasePath)
    expect(existsSync(databasePath)).toBe(false)
  })

  it('answers --help with the usage and touches nothing', () => {
    const { code, out, databasePath } = run(['--help'])

    expect(code).toBe(0)
    expect(out).toBe(usage)
    expect(existsSync(databasePath)).toBe(true)
  })

  it('refuses an argument it does not recognise rather than guessing at it', () => {
    const { code, err, out, databasePath } = run(['--force'])

    expect(code).toBe(2)
    expect(err).toContain('Unrecognised argument: --force')
    expect(out).toBe('')
    expect(existsSync(databasePath)).toBe(true)
  })

  it('deletes under a configuration the server itself would refuse to start on', () => {
    // The startup checks are about running: a non-loopback bind with no public URL, full content
    // bound for a remote provider, and (spec 13) `CAROLINE_ACCESS_TOKEN` set in the environment.
    // None of them says anything about where the data is, and the setup guide's troubleshooting
    // table sends people here holding exactly the content-policy one.
    const directory = mkdtempSync(join(tmpdir(), 'caroline-delete-command-'))
    directories.push(directory)

    const databasePath = join(directory, 'data', 'caroline.db')
    const configPath = join(directory, 'caroline.config.json')
    writeFileSync(
      configPath,
      JSON.stringify({
        database: { path: databasePath },
        server: { host: '0.0.0.0' },
        privacy: { llmContent: 'full' },
        llm: { provider: 'anthropic', model: 'a-model' },
      }),
    )

    // Spec 13, criterion 32: every refusal this milestone adds is a runtime check too, so a
    // `CAROLINE_ACCESS_TOKEN` in the environment that would fail a real start still lets deletion
    // run.
    const env = {
      CAROLINE_CONFIG: configPath,
      CAROLINE_ACCESS_TOKEN: 'a-token',
    } as NodeJS.ProcessEnv
    openCarolineDatabase(
      loadConfig({ file: { database: { path: databasePath } }, env, runtimeChecks: false }),
    ).close()

    let out = ''
    const code = runDeleteCommand(['--yes'], {
      stdout: (text) => (out += text),
      stderr: () => {},
      env,
    })

    expect(code).toBe(0)
    expect(out).toContain(databasePath)
    expect(existsSync(databasePath)).toBe(false)
  })

  it('does not claim it found nothing when what it found would not go', () => {
    // "Caroline has written none of its files here" followed by a list of Caroline's files is a false
    // statement about, among other things, a live Google refresh token.
    const directory = mkdtempSync(join(tmpdir(), 'caroline-delete-command-'))
    directories.push(directory)

    const dataDirectory = join(directory, 'data')
    const databasePath = join(dataDirectory, 'caroline.db')
    const configPath = join(directory, 'caroline.config.json')
    writeFileSync(configPath, JSON.stringify({ database: { path: databasePath } }))

    const env = { CAROLINE_CONFIG: configPath } as NodeJS.ProcessEnv
    openCarolineDatabase(loadConfig({ file: { database: { path: databasePath } }, env })).close()

    if (process.getuid?.() === 0) return

    chmodSync(dataDirectory, 0o500)
    try {
      let out = ''
      let err = ''
      const code = runDeleteCommand(['--yes'], {
        stdout: (text) => (out += text),
        stderr: (text) => (err += text),
        env,
      })

      expect(code).toBe(1)
      expect(out).not.toContain('none of its files here')
      expect(err).toContain('Could not remove:')
      expect(err).toContain(databasePath)
      expect(existsSync(databasePath)).toBe(true)
    } finally {
      chmodSync(dataDirectory, 0o700)
    }
  })

  it('reports a configuration it cannot load rather than deleting a default path', () => {
    const directory = mkdtempSync(join(tmpdir(), 'caroline-delete-command-'))
    directories.push(directory)
    const configPath = join(directory, 'caroline.config.json')
    writeFileSync(configPath, JSON.stringify({ integrations: { github: { token: 'ghp_secret' } } }))

    let err = ''
    const code = runDeleteCommand(['--yes'], {
      stdout: () => {},
      stderr: (text) => (err += text),
      env: { CAROLINE_CONFIG: configPath } as NodeJS.ProcessEnv,
    })

    expect(code).toBe(1)
    expect(err).toContain('Caroline cannot work out what to delete')
    expect(err).toContain('GITHUB_TOKEN')
  })
})

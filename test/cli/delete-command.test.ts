/**
 * The command around the deletion. The property worth a test is the gate: what somebody typing the
 * command without having read it gets is a listing, and their database is still there afterwards.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

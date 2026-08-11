/**
 * `npm run delete-data`: the documented deletion command of spec 09, as far as arguments and output
 * go. The deletion itself is next door in `delete-data.ts`, and the entry point is `delete.ts`.
 *
 * Deleting is not the default. Run without `--yes` it says what it would remove and removes nothing,
 * because the one thing this command must never do is take a database away from somebody who was
 * reading its help.
 */
import { resolve } from 'node:path'
import { ConfigError, loadConfig, readConfigFile } from '../config/load.js'
import { deleteCarolineData } from './delete-data.js'

export const usage = `Usage: npm run delete-data [-- --yes]

Removes everything Caroline has written: the database, its SQLite sidecars, the Google token file
and the temporary sibling an interrupted token write leaves. Nothing else in the data directory is
touched, and the directory itself goes only if Caroline had written something in it and it is empty
afterwards.

  --yes    Actually delete. Without it, this lists what would go and deletes nothing.
  --help   This.

Stop Caroline before running it: deleting the database from under a running process leaves the
process writing to a file nobody can see. Removing the token file is what revoking Caroline's
access locally means, which is not the same as revoking it at Google: do that at
https://myaccount.google.com/permissions if you want it gone from both ends.
`

export interface CommandIo {
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
  readonly env: NodeJS.ProcessEnv
}

/** The exit code. Zero for a run that did what was asked, including a run that found nothing. */
export function runDeleteCommand(
  argv: readonly string[],
  { stdout, stderr, env }: CommandIo,
): number {
  if (argv.includes('--help') || argv.includes('-h')) {
    stdout(usage)
    return 0
  }

  const unknown = argv.filter((argument) => argument !== '--yes')
  if (unknown.length > 0) {
    stderr(`Unrecognised argument: ${unknown.join(' ')}\n\n${usage}`)
    return 2
  }

  const dryRun = !argv.includes('--yes')
  const configPath = resolve(env.CAROLINE_CONFIG ?? 'caroline.config.json')

  let report
  try {
    report = deleteCarolineData(
      // Without the startup checks: this reads the configuration for the data's location and then
      // starts no server and calls no provider, and a content policy nobody may run with is no
      // reason to refuse somebody their own data. A file the schema rejects still stops it, because
      // that is a question about which files to delete which must not be answered by guessing.
      loadConfig({ file: readConfigFile(configPath), env, runtimeChecks: false }),
      { dryRun },
    )
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error
    stderr(`Caroline cannot work out what to delete: ${error.message}\n`)
    return 1
  }

  const links = new Set(report.symlinks)

  stdout(`Data directory: ${report.directory}\n`)

  if (report.removed.length === 0 && report.failed.length === 0) {
    stdout('Nothing to remove: Caroline has written none of its files here.\n')
  } else if (report.removed.length > 0) {
    stdout(dryRun ? '\nWould remove:\n' : '\nRemoved:\n')
    for (const path of report.removed) {
      // Said on the line itself, because "removed the database" about a link is a sentence that has
      // somebody believe a file on another disk has gone when it has not.
      stdout(
        links.has(path) ? `  ${path} (a link; what it points at is untouched)\n` : `  ${path}\n`,
      )
    }
  }

  if (report.leftBehind.length > 0) {
    stdout('\nLeft alone, because Caroline did not write it:\n')
    for (const path of report.leftBehind) stdout(`  ${path}\n`)
  }

  if (report.directoryRemoved) {
    stdout(
      dryRun
        ? `\nWould remove the empty ${report.directory}\n`
        : `\nRemoved the empty ${report.directory}\n`,
    )
  }

  if (dryRun && report.removed.length > 0) {
    stdout('\nNothing was deleted. Re-run with `npm run delete-data -- --yes`.\n')
  }

  if (report.failed.length > 0) {
    // On stderr and with a non-zero code, because a file of Caroline's that is still there is the
    // one outcome somebody running this command needs to know about rather than read past.
    stderr('\nCould not remove:\n')
    for (const { path, message } of report.failed) stderr(`  ${path}: ${message}\n`)
    return 1
  }

  return 0
}

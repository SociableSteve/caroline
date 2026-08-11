/**
 * The entry point of `npm run build:site`. Everything it does is in `build.ts`, which returns the
 * site as a map so that the suite can assert against what would ship rather than against a
 * directory.
 *
 * The output directory is emptied first: a page renamed in the manifest would otherwise stay in the
 * artifact, and a stale page is worse than a missing one because it looks current.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { buildSite } from './build.js'

const directory = process.argv[2] ?? 'dist/site'
const files = buildSite()

rmSync(directory, { recursive: true, force: true })
for (const [path, contents] of files) {
  const destination = join(directory, path)
  mkdirSync(dirname(destination), { recursive: true })
  writeFileSync(destination, contents, 'utf8')
}

process.stdout.write(`Wrote ${files.size} files to ${directory}\n`)

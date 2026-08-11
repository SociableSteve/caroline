/**
 * The entry point of `npm run build:site`. Everything it does is in `build.ts`, which returns the
 * site as a map so that the suite can assert against what would ship rather than against a
 * directory.
 *
 * The output directory is emptied first: a page renamed in the manifest would otherwise stay in the
 * artifact, and a stale page is worse than a missing one because it looks current. It is not
 * configurable, because the one thing this file does is a recursive delete and an argument would let
 * `npm run build:site -- dist` take the compiled server and client with it.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { buildSite } from './build.js'

const directory = 'dist/site'
const files = buildSite()

rmSync(directory, { recursive: true, force: true })
for (const [path, contents] of files) {
  const destination = join(directory, path)
  mkdirSync(dirname(destination), { recursive: true })
  writeFileSync(destination, contents, 'utf8')
}

process.stdout.write(`Wrote ${files.size} files to ${directory}\n`)

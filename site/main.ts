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
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { buildSite, fontAssets, siteAssets } from './build.js'

const directory = 'dist/site'
const files = buildSite()
// The screenshots, which are copied rather than written: `buildSite` returns text, and a PNG carried
// through a string is a PNG with its bytes rewritten. It has already refused to publish a page
// referencing one that is not here.
const assets = [...siteAssets(), ...fontAssets()]

rmSync(directory, { recursive: true, force: true })
for (const [path, contents] of files) {
  const destination = join(directory, path)
  mkdirSync(dirname(destination), { recursive: true })
  writeFileSync(destination, contents, 'utf8')
}

for (const asset of assets) {
  const destination = join(directory, asset.output)
  mkdirSync(dirname(destination), { recursive: true })
  copyFileSync(asset.source, destination)
}

process.stdout.write(`Wrote ${files.size + assets.length} files to ${directory}\n`)

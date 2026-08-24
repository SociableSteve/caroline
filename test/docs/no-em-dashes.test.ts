/**
 * The em-dash rule in `AGENTS.md`, asserted rather than trusted.
 *
 * The convention is that nothing written for a human audience carries an em-dash: prose, code
 * comments, commit messages, PR bodies, docs. A rule nothing checks drifts, and this one had drifted
 * into the specs and the client's comments before it was swept. So every tracked text file is read
 * and the character is looked for, which makes the rule fail here rather than in review.
 *
 * Only the em-dash (U+2014). The en-dash (U+2013) is left alone because the tree uses it for ranges,
 * where it is correct typography rather than a dash standing in for punctuation.
 *
 * No spec criterion is cited, unlike its neighbours here, because no spec covers how the repository
 * is worked on. `AGENTS.md` is the contract this asserts, and it is the one quoted above.
 */
import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const emDash = '\u2014'
const root = process.cwd()

/**
 * Files with no prose in them to check: pictures, fonts, archives, and the lockfile npm writes.
 * Matched on the lower-cased extension, so a `.PNG` is skipped as readily as a `.png`.
 */
const unreadable = new Set([
  '.avif',
  '.eot',
  '.gif',
  '.gz',
  '.ico',
  '.jpeg',
  '.jpg',
  '.otf',
  '.pdf',
  '.png',
  '.ttf',
  '.webp',
  '.woff',
  '.woff2',
  '.zip',
])
const generated = new Set(['package-lock.json'])

/**
 * A regular file present in the working tree. Two things are skipped by this, and neither loses any
 * coverage. A tracked symlink points at something tracked in its own right, `.claude/skills` at a
 * directory and `.github/copilot-instructions.md` at `AGENTS.md`, so its target is read at its real
 * path instead of twice. A path in the index but not on disk, which a sparse checkout or an unstaged
 * deletion leaves, has no content here to read.
 */
const isRegularFile = (path: string): boolean => {
  try {
    return lstatSync(join(root, path)).isFile()
  } catch {
    return false
  }
}

/** The tracked paths, from git, which has to be on PATH and looking at a repository. */
const trackedPaths = (): string[] => {
  try {
    return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0')
  } catch (cause) {
    throw new Error(`git ls-files failed in ${root}, so the tracked files could not be read`, {
      cause,
    })
  }
}

const trackedTextFiles = (): string[] =>
  trackedPaths().filter(
    (path) =>
      path !== '' &&
      !unreadable.has(extname(path).toLowerCase()) &&
      !generated.has(path) &&
      isRegularFile(path),
  )

/** Every offending line, said with its file and line number so the failure names what to fix. */
const offendingLines = (path: string): string[] =>
  readFileSync(join(root, path), 'utf8')
    .split('\n')
    .flatMap((line, index) => (line.includes(emDash) ? [`${path}:${index + 1}: ${line.trim()}`] : []))

describe('the tree holds to the em-dash rule', () => {
  it('carries no em-dash in any tracked file, as AGENTS.md says', () => {
    const offences = trackedTextFiles().flatMap(offendingLines)

    expect(
      offences,
      'AGENTS.md forbids the em-dash: use a colon, a comma, parentheses, or two sentences',
    ).toEqual([])
  })
})

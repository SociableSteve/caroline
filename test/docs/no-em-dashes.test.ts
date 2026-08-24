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
 */
import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const emDash = '\u2014'
const root = process.cwd()

/** Files with no prose in them to check: pictures, fonts, and the lockfile npm writes. */
const unreadable = new Set([
  '.avif',
  '.gif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.png',
  '.webp',
  '.woff',
  '.woff2',
])
const generated = new Set(['package-lock.json'])

/**
 * A regular file, so a tracked symlink is skipped: `.claude/skills` holds one pointing at a
 * directory, and reading it would fail on something that is not prose at all.
 */
const isRegularFile = (path: string): boolean => lstatSync(join(root, path)).isFile()

const trackedTextFiles = (): string[] =>
  execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(
      (path) =>
        path !== '' &&
        !unreadable.has(extname(path)) &&
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

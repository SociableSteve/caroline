/**
 * `.github/copilot-instructions.md` against `AGENTS.md`, the file it is a copy of.
 *
 * The copy exists because Copilot Chat, on every platform, and Visual Studio read that path and no
 * other: they do not read a root `AGENTS.md` the way the coding agent, Copilot code review and the
 * Copilot CLI do. It used to be a symlink, which serves those surfaces a working tree but not the
 * GitHub API, where a symlink is a blob holding the twelve bytes `../AGENTS.md`. So it is a real
 * file now, generated, and this is what keeps the two from drifting.
 *
 * Two invariants, because either one alone would pass while the bug was back. The bytes have to be
 * the notice followed by today's `AGENTS.md`, and the path has to be a regular file rather than a
 * symlink to one.
 *
 * No spec criterion is cited, as in `no-em-dashes.test.ts` next door, because no spec covers how the
 * repository is worked on. `AGENTS.md` is the contract.
 */
import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { COMMAND, DOCUMENT, SOURCE, copilotInstructions } from '../../tools/docs/copilot-instructions.js'

const root = process.cwd()
const committed = (): string => readFileSync(join(root, DOCUMENT), 'utf8')

describe('the Copilot instructions carry the conventions', () => {
  it('holds the notice and the whole of AGENTS.md, byte for byte', () => {
    expect(committed(), `${DOCUMENT} has drifted from ${SOURCE}: run ${COMMAND}`).toBe(
      copilotInstructions(),
    )
  })

  /**
   * The bug the copy was made for. A symlink passes every local check and reads correctly in a
   * clone, and the GitHub API still hands a tool the target's name instead of the conventions, so
   * the shape of the file on disk is asserted rather than only its content.
   */
  it('is a regular file, not a symlink the GitHub API would serve as a path', () => {
    expect(
      lstatSync(join(root, DOCUMENT)).isSymbolicLink(),
      `${DOCUMENT} is a symlink, and the GitHub API serves a symlink's target as its content: run ${COMMAND}`,
    ).toBe(false)
  })

  /** The point of the copy: the conventions themselves are in it, not a path to them. */
  it('contains the conventions rather than a reference to another file', () => {
    const conventions = readFileSync(join(root, SOURCE), 'utf8')

    expect(committed()).toContain(conventions)
    expect(committed().length).toBeGreaterThan(conventions.length)
  })
})

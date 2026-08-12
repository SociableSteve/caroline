/**
 * The payloads `docs/content-policy.md` publishes, against the code that builds the real ones.
 * Spec 09, criterion 15.
 *
 * The document makes a promise about where somebody's mail goes, so the promise is checked rather
 * than reviewed: the generator is the same two functions the classify job calls, and this asserts
 * that what is committed is what they produce today. A change to the payload's shape fails here, with
 * the command that fixes it, instead of leaving a documented payload that is no longer true.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { payloadExamples, regionOf, regions } from '../../tools/docs/content-policy-examples.js'
import { contentLevelRank, contentLevels, type ContentLevel } from '../../src/domain/content.js'

const document = readFileSync(join(process.cwd(), 'docs/content-policy.md'), 'utf8')

describe('the documented payloads are what the content policy produces', () => {
  /**
   * Every region, rather than the payloads alone. The settings block used to sit outside the markers
   * with the snippet cap written into it by hand, so lowering the schema's default left the page
   * quoting 300 in one region and 250 in the next with nothing failing. Whatever this module owns is
   * compared, so adding a region does not mean remembering to add an assertion for it.
   */
  for (const region of regions) {
    it(`carries exactly what the generator generates for ${region.name}, so nothing has drifted`, () => {
      expect(
        regionOf(document, region),
        `docs/content-policy.md no longer matches the code behind ${region.name}: run npm run docs:examples`,
      ).toBe(region.markdown())
    })
  }

  /**
   * Read out of the document, because both orders live there and neither is safe to assume. This used
   * to compare `payloadExamples().map(level)` with `contentLevels`, which is the array the function
   * maps over: the same list on both sides, nothing about the page checked. Reordering `contentLevels`
   * to put `full` before `snippet` and regenerating therefore shipped a table listing them that way,
   * payload sections in the opposite order, and `full`'s note ("The above, with the body whole") over a
   * `metadata` payload, with the whole suite green.
   *
   * What holds the page together is that both sequences run from least exposure to most, since every
   * note describes its level as the one above it plus something. So that is what is asserted, of the
   * committed file, in the two places the levels appear in it.
   */
  it('tabulates the levels and shows their payloads in one order, least exposure first', () => {
    const byExposure = [...contentLevels].sort((a, b) => contentLevelRank[a] - contentLevelRank[b])

    const positionsOf = (locate: (level: ContentLevel) => string): number[] =>
      byExposure.map((level) => {
        const needle = locate(level)
        expect(document, `${needle} is not in docs/content-policy.md`).toContain(needle)

        return document.indexOf(needle)
      })

    const ascending = (positions: readonly number[]): number[] => [...positions].sort((a, b) => a - b)
    const rows = positionsOf((level) => `| \`${level}\` |`)
    const blocks = positionsOf((level) => `### \`${level}\``)

    expect(rows, 'the table of levels is not in order of exposure').toEqual(ascending(rows))
    expect(blocks, 'the payload sections are not in order of exposure').toEqual(ascending(blocks))
    // Every level has both, so a level with a row and no payload block cannot pass the two above.
    expect(rows).toHaveLength(contentLevels.length)
    expect(blocks).toHaveLength(contentLevels.length)
  })

  /**
   * The point of the whole section, asserted rather than left to a reader's eye: the level decides
   * whether a body leaves the machine. `none` sends neither the subject nor the sender either,
   * because a title is content.
   */
  it('sends no body below snippet, part of one at snippet, and the whole of it at full', () => {
    const sent = new Map(payloadExamples().map((example) => [example.level, example.sent]))
    const body = 'Thanks for Tuesday.'
    const end = 'follow up on the rest afterwards.'

    expect(sent.get('none')).not.toContain(body)
    expect(sent.get('none')).not.toContain('Q3 capacity numbers')
    expect(sent.get('metadata')).toContain('Q3 capacity numbers for the board pack')
    expect(sent.get('metadata')).not.toContain(body)
    expect(sent.get('snippet')).toContain(body)
    expect(sent.get('snippet')).not.toContain(end)
    expect(sent.get('full')).toContain(end)
  })

  /**
   * The example is published, and the site refuses to publish anything shaped like an address or a
   * key. Checked at the generator rather than only at the built page, so a field added to the payload
   * fails here, where the fix is obvious, as well as in the site's own criterion 8.
   */
  it('carries no address and nothing shaped like a key in any of them', () => {
    for (const { level, sent } of payloadExamples()) {
      expect(sent, level).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/)
      expect(sent, level).not.toMatch(/\b(gh[pousr]_|github_pat_|sk-[A-Za-z]|AIza)[A-Za-z0-9_-]+/)
    }
  })
})

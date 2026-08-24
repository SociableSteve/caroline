/**
 * Spec 09, criterion 27: the price table the spending ceiling is expressed in reaches no network.
 *
 * Asserted over what the module imports rather than by trusting review, for the reason spec 03's
 * vendor boundary is asserted that way. The argument for committing the prices is an argument
 * about the outbound posture, and a fetch added here later would be a change to that posture made
 * by accident. A module that imports nothing but its own subsystem, which is pure by
 * construction, has nothing to make a request with.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const pricingSource = readFileSync(
  fileURLToPath(new URL('../../src/domain/pricing.ts', import.meta.url)),
  'utf8',
)

/** Static and dynamic alike, as the vendor boundary reads them: `await import(...)` counts. */
function importsIn(source: string): string[] {
  return [...source.matchAll(/(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g)].map(
    (match) => match[1] as string,
  )
}

describe('the committed price table', () => {
  it('is read at all, so an empty pass cannot read as a pass', () => {
    expect(pricingSource).toContain('export const modelPrices')
    expect(pricingSource).toContain('export const exchangeRates')
  })

  it('imports nothing at all, so it can perform no IO and reach no pricing feed', () => {
    expect(importsIn(pricingSource)).toEqual([])
  })

  it('names no HTTP destination, not even in a comment left as a note to fetch one later', () => {
    // The vendors' pricing pages are cited in the module's prose as where the figures were read
    // from, and a bare hostname is a citation. A URL is what a fetch would need.
    expect(pricingSource).not.toMatch(/https?:\/\//)
  })
})

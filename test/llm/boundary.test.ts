import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Spec 03, criterion 4: no vendor SDK type appears outside `src/llm/adapters/`.
 *
 * Asserted by looking at what the tree imports rather than by trusting review. A type-only
 * import leaves no trace at runtime, so a compile-time check would not catch it either; the
 * import statement is the thing that has to be absent, so the import statement is what is
 * looked for.
 */
const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url))

/** The packages that exist only to talk to one provider. */
const vendorPackages = ['@anthropic-ai/sdk', 'openai']

const adaptersDirectory = join('src', 'llm', 'adapters')

function sourceFiles(directory: string): string[] {
  return readdirSync(join(repositoryRoot, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(entry.name) ? [path] : []
  })
}

/**
 * Static and dynamic alike. A guard that only saw `import x from 'openai'` would be one
 * `await import('openai')` away from being bypassed, which for a test whose whole purpose is
 * that the boundary cannot be crossed quietly is the one gap that matters.
 */
function importsIn(path: string): string[] {
  const contents = readFileSync(join(repositoryRoot, path), 'utf8')
  return [...contents.matchAll(/(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g)].map(
    (match) => match[1] as string,
  )
}

describe('the vendor boundary', () => {
  const files = [...sourceFiles('src'), ...sourceFiles('web')]

  // Somewhere to write the samples that prove the reader sees what it claims to see. Outside
  // the repository, so a sample importing a vendor SDK cannot be picked up as an offender.
  let scratch: string
  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'caroline-boundary-'))
  })
  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true })
  })

  it('finds the source tree, so an empty pass cannot read as a pass', () => {
    expect(files.length).toBeGreaterThan(20)
  })

  it.each(vendorPackages)('imports %s only from inside src/llm/adapters', (vendor) => {
    const offenders = files.filter(
      (path) =>
        relative(adaptersDirectory, path).startsWith('..') &&
        importsIn(path).some(
          (specifier) => specifier === vendor || specifier.startsWith(`${vendor}/`),
        ),
    )

    expect(offenders).toEqual([])
  })

  it.each([
    ['a static import', "import Anthropic from '@anthropic-ai/sdk'"],
    ['a dynamic import', "const sdk = await import('openai')"],
    ['a require', "const sdk = require('@anthropic-ai/sdk')"],
    ['a dynamic import with odd spacing', "await import (\n  'openai'\n)"],
  ])('reads %s, so neither form can slip past the boundary check', (_form, source) => {
    const path = join(scratch, 'sample.ts')
    writeFileSync(path, source)

    expect(importsIn(relative(repositoryRoot, path))).toEqual([
      expect.stringMatching(/@anthropic-ai\/sdk|openai/),
    ])
  })

  it('has adapters that do import them, so the check is looking at the right thing', () => {
    const insideAdapters = sourceFiles(adaptersDirectory).flatMap(importsIn)

    for (const vendor of vendorPackages) {
      expect(insideAdapters).toContain(vendor)
    }
  })

  it('keeps the adapters behind the factory: nothing else imports one directly', () => {
    const factory = join('src', 'llm', 'index.ts')

    const offenders = files.filter(
      (path) =>
        path !== factory &&
        relative(adaptersDirectory, path).startsWith('..') &&
        importsIn(path).some((specifier) => specifier.includes('llm/adapters/')),
    )

    expect(offenders).toEqual([])
  })
})

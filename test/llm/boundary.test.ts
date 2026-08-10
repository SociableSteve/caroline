import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

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

function importsIn(path: string): string[] {
  const contents = readFileSync(join(repositoryRoot, path), 'utf8')
  return [...contents.matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)].map(
    (match) => match[1] as string,
  )
}

describe('the vendor boundary', () => {
  const files = [...sourceFiles('src'), ...sourceFiles('web')]

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

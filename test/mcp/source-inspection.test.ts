/**
 * Spec 12, criterion 25: no module reachable from the MCP server imports anything under
 * `src/connectors/`, in the same style `test/chat/registry.test.ts` already asserts it for chat's
 * own registry. The MCP surface reaches the registry, `src/chat/gate.ts`, `src/db/repositories`
 * and `src/mcp` itself; none of that should ever need a connector, because spec 07 criterion 2
 * (no outbound tool) holds across both callers.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url))

function sourceFiles(directory: string): string[] {
  return readdirSync(join(repositoryRoot, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? sourceFiles(path) : /\.ts$/.test(entry.name) ? [path] : []
  })
}

function importsIn(path: string): string[] {
  const contents = readFileSync(join(repositoryRoot, path), 'utf8')
  return [...contents.matchAll(/(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g)].map(
    (match) => match[1] as string,
  )
}

describe('the MCP surface', () => {
  it('never imports a connector, so no tool can reach an external system over this port either', () => {
    const offenders = sourceFiles(join('src', 'mcp')).filter((path) =>
      importsIn(path).some(
        (specifier) => specifier.includes('/connectors/') || specifier.includes('connectors/'),
      ),
    )

    expect(offenders).toEqual([])
  })

  it('never mentions fetch, which is the other way out of the process', () => {
    const offenders = sourceFiles(join('src', 'mcp')).filter((path) =>
      /\bfetch\s*\(/.test(readFileSync(join(repositoryRoot, path), 'utf8')),
    )

    expect(offenders).toEqual([])
  })

  it('finds the mcp source tree, so an empty pass cannot read as a pass', () => {
    expect(sourceFiles(join('src', 'mcp')).length).toBeGreaterThan(2)
  })

  it('names the protocol revision it implements (criterion 40)', () => {
    const contents = readFileSync(join(repositoryRoot, 'src', 'mcp', 'protocol.ts'), 'utf8')
    expect(contents).toContain('2026-07-28')
  })
})

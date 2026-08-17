/**
 * Spec 13, criteria 6, 7 and 28: facts about the whole source tree rather than about one code
 * path, in the style `test/llm/boundary.test.ts` and `test/chat/registry.test.ts` already use.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url))

function sourceFiles(directory: string): string[] {
  return readdirSync(join(repositoryRoot, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(entry.name) ? [path] : []
  })
}

const srcFiles = sourceFiles('src')

function occurrencesOf(needle: string, path: string): number {
  const contents = readFileSync(join(repositoryRoot, path), 'utf8')
  return [...contents.matchAll(new RegExp(needle.replaceAll('.', '\\.'), 'g'))].length
}

describe('CAROLINE_ACCESS_TOKEN and server.accessToken (criterion 7)', () => {
  it('appear nowhere under src/ but src/config/load.ts', () => {
    const elsewhere = srcFiles.filter((path) => path !== join('src', 'config', 'load.ts'))

    for (const path of elsewhere) {
      const contents = readFileSync(join(repositoryRoot, path), 'utf8')
      expect(contents, path).not.toContain('CAROLINE_ACCESS_TOKEN')
      expect(contents, path).not.toContain('server.accessToken')
    }
  })

  it('is not read into the effective configuration any more', () => {
    const loadPath = join('src', 'config', 'load.ts')
    const contents = readFileSync(join(repositoryRoot, loadPath), 'utf8')

    // The old guard assigned `env.CAROLINE_ACCESS_TOKEN` to a config field; the replacement only
    // ever compares it against null in the refusal, and never assigns it to anything.
    expect(contents).not.toMatch(/accessToken:\s*nonEmpty\(env\.CAROLINE_ACCESS_TOKEN\)/)
  })

  it('names both, in the ban-list entry, exactly once', () => {
    const loadPath = join('src', 'config', 'load.ts')

    expect(occurrencesOf("path: 'server.accessToken'", loadPath)).toBe(1)
    expect(occurrencesOf("envHint: 'CAROLINE_ACCESS_TOKEN'", loadPath)).toBe(1)
  })
})

describe('forwarded headers and trustProxy (criterion 6)', () => {
  const gatePath = join('src', 'server', 'auth-gate.ts')
  const appPath = join('src', 'server', 'app.ts')

  it('are read for the forwarded-header refusal only, under src/server/', () => {
    const serverFiles = sourceFiles('src/server')

    for (const path of serverFiles) {
      const contents = readFileSync(join(repositoryRoot, path), 'utf8')
      const carriesForwardedCheck = /x-forwarded-for|\bforwarded\b/i.test(contents)

      if (path === gatePath) {
        expect(carriesForwardedCheck, path).toBe(true)
      } else {
        expect(contents, path).not.toMatch(/x-forwarded-for/i)
      }
    }
  })

  it('is written as an explicit trustProxy: false, exactly once, in buildServer', () => {
    const contents = readFileSync(join(repositoryRoot, appPath), 'utf8')

    expect([...contents.matchAll(/trustProxy/g)]).toHaveLength(1)
    expect(contents).toContain('trustProxy: false')
  })

  it('appears nowhere else under src/', () => {
    for (const path of srcFiles) {
      if (path === appPath) continue
      const contents = readFileSync(join(repositoryRoot, path), 'utf8')
      expect(contents, path).not.toContain('trustProxy')
    }
  })
})

describe('no Google host, endpoint or non-standard claim under src/auth (criterion 28)', () => {
  const authFiles = sourceFiles('src/auth')

  // Precise about what counts as "a Google host or endpoint": the hosts a Google OAuth/OIDC
  // client actually talks to. Not the bare word "Google", which the comments in `pkce.ts`,
  // `token.ts` and `service.ts` use legitimately to point at the *other* client
  // (`src/connectors/google/`) whose code this one deliberately does not reuse.
  const googleHostPatterns = [
    /accounts\.google\.com/i,
    /googleapis\.com/i,
    /google\.com\/o\/oauth2/i,
  ]

  it('contains no Google host or endpoint', () => {
    for (const path of authFiles) {
      const contents = readFileSync(join(repositoryRoot, path), 'utf8')
      for (const pattern of googleHostPatterns) {
        expect(contents, `${path} matched ${pattern}`).not.toMatch(pattern)
      }
    }
  })

  it('contains no non-standard claim name, such as hd, the Workspace hosted-domain claim', () => {
    for (const path of authFiles) {
      const contents = readFileSync(join(repositoryRoot, path), 'utf8')
      expect(contents, path).not.toMatch(/\bhd\b/)
    }
  })

  it('does not send access_type=offline or prompt=consent, which exist only to obtain a refresh token this flow has no use for', () => {
    for (const path of authFiles) {
      const contents = readFileSync(join(repositoryRoot, path), 'utf8')
      expect(contents, path).not.toMatch(/access_type/i)
      expect(contents, path).not.toMatch(/prompt=consent/i)
      expect(contents, path).not.toMatch(/prompt:\s*['"]consent['"]/i)
    }
  })
})

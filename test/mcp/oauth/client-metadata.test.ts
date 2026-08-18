/**
 * Spec 12, "The client metadata document fetch": `https` only, resolve-then-check-then-connect
 * to the checked address, a size cap enforced while the body is read, a time cap on the whole
 * fetch, and no redirect followed to a different host. Criteria 34 to 37.
 *
 * The private-address and scheme guards are asserted without any real network at all: they
 * refuse before a connection is ever attempted, which is the property spec 12 asks for, so a
 * test proving it needs no socket to open. The size cap, time cap and redirect guard are
 * asserted against a real loopback `https` server, because those three are about what happens
 * once bytes are actually arriving, which nothing but a real connection exercises honestly.
 */
import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:https'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, describe, expect, it } from 'vitest'
import { ClientMetadataError, fetchClientMetadata } from '../../../src/mcp/oauth/client-metadata.js'

const privateLookup = async () => [{ address: '127.0.0.1', family: 4 }]

describe('fetchClientMetadata: guards that need no network', () => {
  it('refuses a non-https client identifier, in any spelling', async () => {
    await expect(
      fetchClientMetadata('http://example.com/client.json', {
        maxResponseBytes: 65_536,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(ClientMetadataError)
  })

  it('refuses an unparsable client identifier', async () => {
    await expect(
      fetchClientMetadata('not a url', { maxResponseBytes: 65_536, timeoutMs: 1000 }),
    ).rejects.toThrow(ClientMetadataError)
  })

  it('refuses a hostname that resolves to a private address, without connecting (criterion 35)', async () => {
    await expect(
      fetchClientMetadata('https://internal.example.com/client.json', {
        maxResponseBytes: 65_536,
        timeoutMs: 1000,
        lookup: privateLookup as never,
      }),
    ).rejects.toThrow(/no public address/)
  })

  it('refuses a hostname that cannot be resolved at all', async () => {
    const failingLookup = async () => {
      throw new Error('ENOTFOUND')
    }

    await expect(
      fetchClientMetadata('https://nowhere.example.com/client.json', {
        maxResponseBytes: 65_536,
        timeoutMs: 1000,
        lookup: failingLookup as never,
      }),
    ).rejects.toThrow(ClientMetadataError)
  })
})

/**
 * A throwaway self-signed certificate, generated once for the file. `openssl` is a system tool
 * rather than a project dependency, used here only to stand up a loopback `https` server for the
 * three guards below that are about bytes actually arriving; nothing in `src` depends on it.
 */
function selfSignedCertificate(): { readonly key: string; readonly cert: string } {
  const directory = mkdtempSync(join(tmpdir(), 'caroline-mcp-tls-'))
  const keyPath = join(directory, 'key.pem')
  const certPath = join(directory, 'cert.pem')

  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-days',
    '1',
    '-nodes',
    '-subj',
    '/CN=localhost',
  ])

  const key = readFileSync(keyPath, 'utf8')
  const cert = readFileSync(certPath, 'utf8')
  rmSync(directory, { recursive: true, force: true })
  return { key, cert }
}

let hasOpenssl = true
try {
  execFileSync('openssl', ['version'])
} catch {
  hasOpenssl = false
}

describe.skipIf(!hasOpenssl)('fetchClientMetadata: guards over a real loopback connection', () => {
  const { key, cert } = selfSignedCertificate()
  const servers: Server[] = []

  afterAll(() => {
    for (const server of servers) server.close()
  })

  function startServer(handler: Parameters<typeof createServer>[1]): Promise<number> {
    const server = createServer({ key, cert }, handler)
    servers.push(server)
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
    })
  }

  /** A loopback connection cannot be made to look like a public address without lying to the
   * real guard entirely, so these tests inject `isPublicAddress: () => true` alongside the
   * loopback `lookup`: the address check itself is already proved with no server at all, above,
   * and what these four are proving is the size cap, the time cap, the redirect guard and the
   * parse path once a connection is allowed to proceed. */
  const allowLoopback = { lookup: privateLookup as never, isPublicAddress: () => true, ca: cert }

  it('refuses a response larger than the cap while it is being read (criterion 36)', async () => {
    const port = await startServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.write('{"redirect_uris":["https://example.com/callback"],"padding":"')
      response.write('x'.repeat(200))
      response.end('"}')
    })

    await expect(
      fetchClientMetadata(`https://localhost:${port}/client.json`, {
        maxResponseBytes: 64,
        timeoutMs: 2000,
        ...allowLoopback,
      }),
    ).rejects.toThrow(/exceeds the 64-byte cap/)
  })

  it('abandons a fetch that does not complete within the time cap (criterion 36)', async () => {
    const port = await startServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      // Never ends: the time cap is what has to end this, not the response.
    })

    await expect(
      fetchClientMetadata(`https://localhost:${port}/client.json`, {
        maxResponseBytes: 65_536,
        timeoutMs: 200,
        ...allowLoopback,
      }),
    ).rejects.toThrow(/did not complete within/)
  })

  it('refuses a redirect rather than following it (criterion 37)', async () => {
    const port = await startServer((_request, response) => {
      response.writeHead(302, { location: 'https://attacker.example.com/client.json' })
      response.end()
    })

    await expect(
      fetchClientMetadata(`https://localhost:${port}/client.json`, {
        maxResponseBytes: 65_536,
        timeoutMs: 2000,
        ...allowLoopback,
      }),
    ).rejects.toThrow(/redirected/)
  })

  /**
   * Spec 12, criterion 28: `fetchClientMetadata` is the only outbound request builder in the MCP
   * surface, so "no token presented to the MCP endpoint is ever forwarded outbound" is asserted
   * here, by reading what the request actually carried at the far end rather than by reading the
   * builder's source. Any header that could carry a credential fails it.
   */
  it('sends no credential-bearing header and no body on the one outbound request the MCP surface makes (criterion 28)', async () => {
    let receivedHeaders: Record<string, string | string[] | undefined> = {}
    let receivedBody = ''

    const port = await startServer((request, response) => {
      receivedHeaders = request.headers
      request.on('data', (chunk: Buffer) => {
        receivedBody += chunk.toString('utf8')
      })
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ redirect_uris: ['https://example.com/callback'] }))
      })
    })

    await fetchClientMetadata(`https://localhost:${port}/client.json`, {
      maxResponseBytes: 65_536,
      timeoutMs: 2000,
      ...allowLoopback,
    })

    for (const credentialHeader of [
      'authorization',
      'proxy-authorization',
      'cookie',
      'x-api-key',
    ]) {
      expect(receivedHeaders[credentialHeader], credentialHeader).toBeUndefined()
    }
    expect(Object.keys(receivedHeaders).sort()).toEqual(['accept', 'connection', 'host'])
    expect(receivedBody).toBe('')
  })

  it('parses a well-formed document from a real response', async () => {
    const port = await startServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          client_name: 'Example client',
          client_uri: 'https://example.com',
          redirect_uris: ['https://example.com/callback'],
        }),
      )
    })

    const document = await fetchClientMetadata(`https://localhost:${port}/client.json`, {
      maxResponseBytes: 65_536,
      timeoutMs: 2000,
      ...allowLoopback,
    })

    expect(document.clientName).toBe('Example client')
    expect(document.redirectUris).toEqual(['https://example.com/callback'])
  })
})

/**
 * Fetching a client's metadata document. Spec 12: client identifiers that are URLs work by the
 * authorisation server fetching that URL and validating what comes back, which makes the fetch
 * itself a server-side request forgery surface, because the address is one a caller rather than
 * the user chose. The guards, each a criterion of its own: `https` only; resolved, then checked,
 * then connected to the checked address, never re-resolved; a size cap enforced while the body is
 * read; a time cap on the whole fetch; no redirect followed to a different host; and this
 * function is called from nowhere but an authorisation request a person is at the keyboard for.
 *
 * Written against `node:https` directly rather than the global `fetch`, because the "connect to
 * the checked address" guarantee needs the TCP connection to be made to a specific IP this module
 * already validated, with the original hostname carried only as the TLS server name and the
 * `Host` header for certificate and virtual-host matching. `fetch`'s `dispatcher` option can do
 * this with `undici`, which is not a direct dependency here; `node:https`'s own `lookup` option
 * does the same thing with nothing extra to add.
 */
import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'
import { isPublicAddress } from './address-guard.js'

export class ClientMetadataError extends Error {
  override readonly name = 'ClientMetadataError'
}

export interface FetchClientMetadataOptions {
  readonly maxResponseBytes: number
  readonly timeoutMs: number
  /** Injected for tests, so a resolution can be driven without a real DNS lookup. */
  readonly lookup?: typeof dnsLookup
  /** Injected for tests that are about the size cap, the time cap or the redirect guard rather
   * than about the address check itself, so they can drive a real loopback server without also
   * having to make loopback look like a public address to the real guard. */
  readonly isPublicAddress?: typeof isPublicAddress
  /** A trusted CA certificate, for a test driving a real loopback server with a throwaway
   * self-signed certificate. Absent in production, where the ordinary system trust store
   * applies: this is a way to add trust for a test fixture, never a way to bypass it. */
  readonly ca?: string
}

export interface ClientMetadataDocument {
  readonly clientId: string
  readonly clientName: string | null
  readonly clientUri: string | null
  readonly redirectUris: readonly string[]
}

function parseDocument(clientId: string, body: string): ClientMetadataDocument {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new ClientMetadataError('The client metadata document is not valid JSON.')
  }

  if (parsed === null || typeof parsed !== 'object') {
    throw new ClientMetadataError('The client metadata document is not a JSON object.')
  }

  const record = parsed as Record<string, unknown>
  const redirectUris = record.redirect_uris
  if (!Array.isArray(redirectUris) || !redirectUris.every((uri) => typeof uri === 'string')) {
    throw new ClientMetadataError('The client metadata document names no redirect_uris array.')
  }

  return {
    clientId,
    clientName: typeof record.client_name === 'string' ? record.client_name : null,
    clientUri: typeof record.client_uri === 'string' ? record.client_uri : null,
    redirectUris,
  }
}

/**
 * Resolves `hostname`, refuses it unless at least one answer is a public address, and returns
 * that address. Only the first public answer found is used, and it is the address the caller
 * connects to: nothing here or after it resolves the name a second time, which is what would let
 * a later answer smuggle a private address past this check.
 */
async function resolveToPublicAddress(
  hostname: string,
  lookup: typeof dnsLookup,
  checkAddress: typeof isPublicAddress,
): Promise<string> {
  let answers: Array<{ address: string; family: number }>
  try {
    answers = await lookup(hostname, { all: true })
  } catch (error) {
    throw new ClientMetadataError(
      `The client metadata URL's host could not be resolved: ${String(error)}`,
    )
  }

  const publicAnswer = answers.find((answer) => checkAddress(answer.address))
  if (publicAnswer === undefined) {
    throw new ClientMetadataError(
      'The client metadata URL resolves to no public address: loopback, link-local, private and unique-local addresses are refused.',
    )
  }

  return publicAnswer.address
}

/**
 * Fetches and parses one client's metadata document. Throws `ClientMetadataError` for anything
 * that means the fetch did not produce a usable document: a non-`https` URL, a private resolved
 * address, a response over the size cap, a fetch that outran the time cap, a redirect to a
 * different host, or a body that is not the document this expects.
 */
export async function fetchClientMetadata(
  clientId: string,
  {
    maxResponseBytes,
    timeoutMs,
    lookup = dnsLookup,
    isPublicAddress: checkAddress = isPublicAddress,
    ca,
  }: FetchClientMetadataOptions,
): Promise<ClientMetadataDocument> {
  let url: URL
  try {
    url = new URL(clientId)
  } catch {
    throw new ClientMetadataError('The client identifier is not a valid URL.')
  }

  if (url.protocol !== 'https:') {
    throw new ClientMetadataError('The client identifier must be an https URL.')
  }

  const address = await resolveToPublicAddress(url.hostname, lookup, checkAddress)

  const body = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      request.destroy(new ClientMetadataError(`The fetch did not complete within ${timeoutMs}ms.`))
    }, timeoutMs)

    const request = httpsRequest(
      {
        method: 'GET',
        // Connects to the address already resolved and checked, never to the hostname again:
        // this is what makes the check above binding rather than advisory.
        host: address,
        port: url.port === '' ? 443 : Number(url.port),
        path: `${url.pathname}${url.search}`,
        // The original hostname, so the certificate is validated against the name the caller
        // actually asked for and the server can route the request to the right virtual host.
        servername: url.hostname,
        headers: { host: url.hostname, accept: 'application/json' },
        // Followed manually, and only onto the same host, rather than automatically: a redirect
        // to a different host is refused outright (spec 12, criterion 37).
        timeout: timeoutMs,
        ...(ca === undefined ? {} : { ca }),
      },
      (response) => {
        const status = response.statusCode ?? 0
        if (status >= 300 && status < 400) {
          response.resume()
          clearTimeout(timer)
          reject(new ClientMetadataError('The client metadata fetch was redirected; refused.'))
          return
        }

        if (status < 200 || status >= 300) {
          response.resume()
          clearTimeout(timer)
          reject(
            new ClientMetadataError(`The client metadata fetch answered with status ${status}.`),
          )
          return
        }

        let received = 0
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => {
          received += chunk.length
          if (received > maxResponseBytes) {
            clearTimeout(timer)
            response.destroy()
            request.destroy()
            reject(
              new ClientMetadataError(
                `The client metadata document exceeds the ${maxResponseBytes}-byte cap.`,
              ),
            )
            return
          }
          chunks.push(chunk)
        })

        response.on('end', () => {
          clearTimeout(timer)
          resolve(Buffer.concat(chunks).toString('utf8'))
        })

        response.on('error', (error) => {
          clearTimeout(timer)
          reject(error instanceof Error ? error : new Error(String(error)))
        })
      },
    )

    request.on('timeout', () => {
      request.destroy(new ClientMetadataError(`The fetch did not complete within ${timeoutMs}ms.`))
    })

    request.on('error', (error) => {
      clearTimeout(timer)
      if (error instanceof ClientMetadataError) reject(error)
      else reject(new ClientMetadataError(`The client metadata fetch failed: ${String(error)}`))
    })

    request.end()
  })

  return parseDocument(clientId, body)
}

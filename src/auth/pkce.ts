/**
 * State, PKCE and nonce for the login flow. Spec 13 follows the Google data client's *pattern*
 * for this deliberately without reusing its code: `createPkce`, `createState` and their
 * `base64Url` helper in `src/connectors/google/oauth.ts` are module-private and belong to that
 * client. This is a separate implementation for a separate flow.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export interface Pkce {
  readonly verifier: string
  readonly challenge: string
}

export function createPkce(): Pkce {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest().toString('base64url')
  return { verifier, challenge }
}

/**
 * The other side of `createPkce`: whether a presented verifier hashes to a stored challenge.
 * Caroline is the client here when it logs in to the identity provider, which is what
 * `createPkce` is for, and the authorisation server when an MCP client logs in to Caroline
 * (spec 12), which is what this is for. `S256` only: the protocol requires it and refuses
 * `plain` and no method at all (spec 12, criterion 27), so there is no second branch to add.
 */
export function verifyPkce(verifier: string, challenge: string): boolean {
  const computed = createHash('sha256').update(verifier).digest()
  const expected = Buffer.from(challenge, 'base64url')
  return computed.length === expected.length && timingSafeEqual(computed, expected)
}

export function createState(): string {
  return randomBytes(16).toString('base64url')
}

export function createNonce(): string {
  return randomBytes(16).toString('base64url')
}

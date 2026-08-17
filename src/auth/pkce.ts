/**
 * State, PKCE and nonce for the login flow. Spec 13 follows the Google data client's *pattern*
 * for this deliberately without reusing its code: `createPkce`, `createState` and their
 * `base64Url` helper in `src/connectors/google/oauth.ts` are module-private and belong to that
 * client. This is a separate implementation for a separate flow.
 */
import { createHash, randomBytes } from 'node:crypto'

export interface Pkce {
  readonly verifier: string
  readonly challenge: string
}

export function createPkce(): Pkce {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest().toString('base64url')
  return { verifier, challenge }
}

export function createState(): string {
  return randomBytes(16).toString('base64url')
}

export function createNonce(): string {
  return randomBytes(16).toString('base64url')
}

/**
 * The OIDC `id_token`, decoded and checked without its signature verified. Spec 13, "The
 * identity token is validated and its signature is not": the token arrives in the body of a
 * direct TLS request Caroline itself made to the provider's token endpoint, which OIDC Core
 * permits as sufficient in the authorization code flow. Claims checked: `iss`, `aud`, `exp`,
 * `nonce`.
 */

export class IdTokenError extends Error {
  override readonly name = 'IdTokenError'
}

export interface IdTokenClaims {
  readonly iss: string
  readonly aud: string
  readonly exp: number
  readonly sub: string
  readonly nonce: string | null
  readonly email: string | null
  readonly emailVerified: boolean
}

/**
 * A JWT's middle segment, base64url JSON, read without checking the signature either side of
 * it. That is the decision this file exists to carry out, not an oversight: see spec 13's
 * reasoning above.
 */
export function decodeIdToken(idToken: string): IdTokenClaims {
  const parts = idToken.split('.')
  if (parts.length !== 3) {
    throw new IdTokenError('The id_token is not a JWT: it does not have three segments.')
  }

  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >
  } catch {
    throw new IdTokenError('The id_token payload is not valid JSON.')
  }

  const { iss, aud, exp, sub, nonce, email, email_verified: emailVerified } = payload

  if (typeof iss !== 'string' || typeof aud !== 'string' || typeof sub !== 'string') {
    throw new IdTokenError('The id_token is missing iss, aud or sub.')
  }
  if (typeof exp !== 'number') {
    throw new IdTokenError('The id_token is missing exp.')
  }

  return {
    iss,
    aud,
    exp,
    sub,
    nonce: typeof nonce === 'string' ? nonce : null,
    email: typeof email === 'string' ? email : null,
    emailVerified: emailVerified === true,
  }
}

export interface ValidateIdTokenOptions {
  readonly issuer: string
  readonly clientId: string
  readonly nonce: string
  readonly now: number
}

/**
 * `iss` equals the configured issuer, `aud` equals the client id, `exp` is in the future, and
 * `nonce` is the one issued for this attempt. Each check named separately so criterion 14's four
 * cases each have their own message and their own test. `exp` is seconds since the epoch, per
 * OIDC Core; `now` here is milliseconds, as everywhere else in Caroline.
 */
export function validateIdToken(claims: IdTokenClaims, options: ValidateIdTokenOptions): void {
  if (claims.iss !== options.issuer) {
    throw new IdTokenError(
      `The id_token's iss ("${claims.iss}") does not match the configured issuer ("${options.issuer}").`,
    )
  }
  if (claims.aud !== options.clientId) {
    throw new IdTokenError("The id_token's aud does not match auth.provider.clientId.")
  }
  if (claims.exp * 1000 <= options.now) {
    throw new IdTokenError('The id_token has expired.')
  }
  if (claims.nonce !== options.nonce) {
    throw new IdTokenError('The id_token nonce does not match the one this attempt issued.')
  }
}

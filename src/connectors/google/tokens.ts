/**
 * The token file: the one thing Caroline writes outside the database. Mode 0600, beside the
 * database, never in the config and never in git. Spec 09.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** What is kept between runs. The access token is cached with it to save a needless refresh. */
export interface StoredTokens {
  readonly refreshToken: string
  readonly accessToken: string | null
  readonly expiresAt: number | null
  readonly scope: string | null
  /** When consent was given, which is what the settings screen shows. */
  readonly connectedAt: number
}

/** Owner read and write only. Anything wider and the file is a secret in name only. */
const FILE_MODE = 0o600

export function readTokens(path: string): StoredTokens | null {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    // No file is the normal state of a Caroline nobody has connected yet.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // A file that is not JSON is no more use than no file, and it must not stop the process
    // starting: `createGoogleAuth` reads this during construction, so throwing here would mean a
    // Caroline that cannot boot until somebody deletes a file by hand. Reconnecting rewrites it.
    return null
  }

  if (parsed === null || typeof parsed !== 'object') return null

  const { refreshToken, accessToken, expiresAt, scope, connectedAt } = parsed as Record<
    string,
    unknown
  >

  // A file without a refresh token cannot get an access token, so it is no better than no file.
  if (typeof refreshToken !== 'string' || refreshToken === '') return null

  return {
    refreshToken,
    accessToken: typeof accessToken === 'string' && accessToken !== '' ? accessToken : null,
    expiresAt: typeof expiresAt === 'number' ? expiresAt : null,
    scope: typeof scope === 'string' ? scope : null,
    connectedAt: typeof connectedAt === 'number' ? connectedAt : 0,
  }
}

/**
 * Written to a sibling temporary file and renamed over the target, because `writeFileSync`
 * truncates before it writes: interrupted, that leaves a half-written file where a token file
 * should be. A rename within one directory is atomic, so a reader sees either the old tokens or
 * the new ones and never half of either.
 *
 * The mode is set at creation and again afterwards: `writeFileSync`'s mode is masked by the
 * process umask on creation and ignored entirely for a file that already exists, so neither on its
 * own guarantees 0600. It is applied to the temporary file, which is the one that becomes the
 * target, so the wider mode never exists even briefly.
 */
export function writeTokens(path: string, tokens: StoredTokens): void {
  mkdirSync(dirname(path), { recursive: true })

  const temporary = `${path}.tmp`
  writeFileSync(temporary, `${JSON.stringify(tokens, null, 2)}\n`, { mode: FILE_MODE })
  chmodSync(temporary, FILE_MODE)
  renameSync(temporary, path)
}

/** Disconnecting. Removing the file is exactly what revoking Caroline's access locally means. */
export function deleteTokens(path: string): boolean {
  try {
    rmSync(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

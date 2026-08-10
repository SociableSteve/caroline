/**
 * The token file: the one thing Caroline writes outside the database. Mode 0600, beside the
 * database, never in the config and never in git. Spec 09.
 */
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

  const parsed: unknown = JSON.parse(raw)
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
 * Written with the mode set at creation, and set again afterwards: `writeFileSync`'s mode is
 * masked by the process umask on creation and ignored entirely for a file that already exists,
 * so neither on its own guarantees 0600.
 */
export function writeTokens(path: string, tokens: StoredTokens): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(tokens, null, 2)}\n`, { mode: FILE_MODE })
  chmodSync(path, FILE_MODE)
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

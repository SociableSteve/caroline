import { secretPaths, type Config } from './schema.js'

export const REDACTED = '[redacted]'

type Mutable = Record<string, unknown>

function readPath(source: unknown, path: readonly string[]): unknown {
  return path.reduce<unknown>((current, key) => {
    if (current === null || typeof current !== 'object') return undefined
    return (current as Mutable)[key]
  }, source)
}

function writePath(target: Mutable, path: readonly string[], value: unknown): void {
  const parents = path.slice(0, -1)
  const leaf = path[path.length - 1]
  if (leaf === undefined) return

  let current: Mutable = target
  for (const key of parents) {
    const next = current[key]
    if (next === null || typeof next !== 'object') return
    current = next as Mutable
  }
  current[leaf] = value
}

/**
 * Secret-looking values found in the environment that the effective config does not use:
 * an OpenAI key while running Anthropic, a GitHub token while GitHub is disabled. They are
 * still scrubbed, so the "no secret in a log line" guarantee does not depend on which
 * provider happens to be selected. Held beside the config rather than on it, so they can
 * never be serialised into an API response.
 */
const unusedEnvironmentSecrets = new WeakMap<Config, readonly string[]>()

export function registerEnvironmentSecrets(config: Config, values: readonly string[]): void {
  unusedEnvironmentSecrets.set(
    config,
    values.filter((value) => value.length > 0),
  )
}

/**
 * A secret that only exists once the process is running: an OAuth access or refresh token,
 * which arrives from Google rather than from the environment and is written to the token file
 * rather than to the config. It is registered so that the "no secret in a log line" guarantee
 * covers it as well, which it could not do by reading the configuration alone. Spec 09,
 * criterion 6.
 */
export function registerRuntimeSecret(config: Config, value: string | null | undefined): void {
  if (typeof value !== 'string' || value.length === 0) return

  const existing = unusedEnvironmentSecrets.get(config) ?? []
  if (existing.includes(value)) return

  unusedEnvironmentSecrets.set(config, [...existing, value])
}

/** Every secret value that is actually set. Empty values are excluded: scrubbing "" would
 * replace every character boundary in a string. */
export function secretValues(config: Config): string[] {
  const fromConfig = secretPaths
    .map((path) => readPath(config, path))
    .filter((value): value is string => typeof value === 'string' && value.length > 0)

  return [...new Set([...fromConfig, ...(unusedEnvironmentSecrets.get(config) ?? [])])]
}

/**
 * A deep copy of the configuration with every secret replaced. Unset secrets stay null, so
 * the caller can still tell "not configured" from "configured but hidden". Spec 09.
 */
export function redactConfig(config: Config): Config {
  const copy = structuredClone(config) as unknown as Mutable

  for (const path of secretPaths) {
    if (typeof readPath(config, path) === 'string') {
      writePath(copy, path, REDACTED)
    }
  }

  return copy as unknown as Config
}

/**
 * Replaces any configured secret appearing in a string. Matching is literal: this runs on
 * values before anything encodes them, so it does not try to recognise a secret through an
 * encoding. Chasing encodings here does not terminate (percent-encoding in either hex
 * case, JSON escaping, whatever an upstream SDK does), so the encodings are handled by
 * removing the places they can occur instead. See `log-redaction.ts`.
 *
 * Longest secret first, so a secret that is a prefix of another cannot be replaced first
 * and leave the longer one's tail exposed.
 */
export function redactSecrets(text: string, config: Config): string {
  return secretValues(config)
    .sort((left, right) => right.length - left.length)
    .reduce((scrubbed, secret) => scrubbed.split(secret).join(REDACTED), text)
}

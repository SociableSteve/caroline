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
 * How long a secret the configuration does not hold is expected to last.
 *
 * `lasting` values are few and are kept for the life of the process: the environment keys, and a
 * refresh token, which survives until consent is withdrawn. `rotating` values are replaced on a
 * schedule the provider chooses, so they accumulate, and the list of them is bounded.
 */
export type SecretLifetime = 'lasting' | 'rotating'

/**
 * How many rotating secrets are kept. An access token lasts an hour and is replaced by a refresh,
 * so a handful covers every token that could still turn up in a log line, and the ones dropped are
 * long expired. Without a bound the list would grow for the life of the process and the scrubber
 * would scan all of it for every line.
 */
const ROTATING_LIMIT = 8

interface ExtraSecrets {
  readonly lasting: readonly string[]
  readonly rotating: readonly string[]
}

const noExtras: ExtraSecrets = { lasting: [], rotating: [] }

/**
 * Secrets the effective config does not hold, which are scrubbed all the same. Two kinds arrive
 * here: values found in the environment that this configuration does not use (an OpenAI key while
 * running Anthropic, a GitHub token while GitHub is disabled), so the "no secret in a log line"
 * guarantee does not depend on which provider happens to be selected; and the OAuth tokens, which
 * exist only once the process is running. Held beside the config rather than on it, so they can
 * never be serialised into an API response.
 */
const extraSecrets = new WeakMap<Config, ExtraSecrets>()

export function registerEnvironmentSecrets(config: Config, values: readonly string[]): void {
  extraSecrets.set(config, {
    ...(extraSecrets.get(config) ?? noExtras),
    lasting: values.filter((value) => value.length > 0),
  })
}

/**
 * A secret that only exists once the process is running: an OAuth access or refresh token, which
 * arrives from Google rather than from the environment and is written to the token file rather
 * than to the config. It is registered so that the "no secret in a log line" guarantee covers it
 * as well, which it could not do by reading the configuration alone. Spec 09, criterion 6.
 *
 * The lifetime decides whether the value is kept or eventually dropped. The refresh token is
 * `lasting` on purpose: it is the more sensitive of the pair and the one that would still be worth
 * scrubbing an hour later, so it must not be evicted by the access tokens it goes on producing.
 */
export function registerRuntimeSecret(
  config: Config,
  value: string | null | undefined,
  lifetime: SecretLifetime = 'lasting',
): void {
  if (typeof value !== 'string' || value.length === 0) return

  const existing = extraSecrets.get(config) ?? noExtras
  if (existing.lasting.includes(value) || existing.rotating.includes(value)) return

  extraSecrets.set(
    config,
    lifetime === 'lasting'
      ? { ...existing, lasting: [...existing.lasting, value] }
      : { ...existing, rotating: [...existing.rotating, value].slice(-ROTATING_LIMIT) },
  )
}

/** Every secret value that is actually set. Empty values are excluded: scrubbing "" would
 * replace every character boundary in a string. */
export function secretValues(config: Config): string[] {
  const fromConfig = secretPaths
    .map((path) => readPath(config, path))
    .filter((value): value is string => typeof value === 'string' && value.length > 0)

  const extras = extraSecrets.get(config) ?? noExtras

  return [...new Set([...fromConfig, ...extras.lasting, ...extras.rotating])]
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

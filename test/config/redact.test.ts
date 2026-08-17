import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config/load.js'
import {
  redactConfig,
  redactSecrets,
  REDACTED,
  registerRuntimeSecret,
  // The local `secretValues` below is the environment's; this is what the scrubber will actually use.
  secretValues as scrubbedValues,
} from '../../src/config/redact.js'

const configuredEnv = {
  ANTHROPIC_API_KEY: 'sk-ant-supersecret',
  GITHUB_TOKEN: 'ghp_supersecret',
  GOOGLE_CLIENT_SECRET: 'google-supersecret',
  CAROLINE_AUTH_CLIENT_SECRET: 'access-supersecret',
} as NodeJS.ProcessEnv

const secretValues = Object.values(configuredEnv) as string[]

describe('redactConfig', () => {
  it('replaces every secret value with a redaction marker', () => {
    const config = loadConfig({ file: { llm: { provider: 'anthropic' } }, env: configuredEnv })

    const redacted = redactConfig(config)
    const serialised = JSON.stringify(redacted)

    for (const secret of secretValues) {
      expect(serialised).not.toContain(secret)
    }
    expect(redacted.llm.apiKey).toBe(REDACTED)
    expect(redacted.integrations.github.token).toBe(REDACTED)
    expect(redacted.integrations.google.clientSecret).toBe(REDACTED)
    expect(redacted.auth.provider.clientSecret).toBe(REDACTED)
  })

  /** An override may name a hosted provider the base config never did. Spec 09, criterion 8. */
  it('replaces the key an override resolved, not only the base one', () => {
    const config = loadConfig({
      file: {
        llm: {
          provider: 'ollama',
          model: 'llama',
          overrides: { chat: { provider: 'anthropic', model: 'claude' } },
        },
      },
      env: configuredEnv,
    })

    const redacted = redactConfig(config)

    expect(config.llm.overrides.chat?.apiKey).toBe('sk-ant-supersecret')
    expect(redacted.llm.overrides.chat?.apiKey).toBe(REDACTED)
    expect(JSON.stringify(redacted)).not.toContain('sk-ant-supersecret')
  })

  it('leaves an override that is not configured absent rather than half-built', () => {
    const config = loadConfig({ file: null, env: configuredEnv })

    expect(redactConfig(config).llm.overrides).toEqual({ classification: null, chat: null })
  })

  it('leaves unset secrets as null rather than pretending they exist', () => {
    const config = loadConfig({ file: null, env: {} as NodeJS.ProcessEnv })

    const redacted = redactConfig(config)

    expect(redacted.llm.apiKey).toBeNull()
    expect(redacted.integrations.github.token).toBeNull()
  })

  it('keeps non-secret values intact', () => {
    const config = loadConfig({ file: { server: { port: 6000 } }, env: configuredEnv })

    const redacted = redactConfig(config)

    expect(redacted.server.port).toBe(6000)
    expect(redacted.privacy.llmContent).toBe('snippet')
  })

  it('does not mutate the configuration it was given', () => {
    const config = loadConfig({ file: null, env: configuredEnv })

    redactConfig(config)

    expect(config.integrations.github.token).toBe('ghp_supersecret')
  })
})

describe('redactSecrets', () => {
  it('scrubs secret values out of an arbitrary string', () => {
    const config = loadConfig({ file: null, env: configuredEnv })

    const message = `failed calling GitHub with token ghp_supersecret`

    expect(redactSecrets(message, config)).toBe(`failed calling GitHub with token ${REDACTED}`)
  })

  it('scrubs every secret in the environment, including ones this config does not use', () => {
    const config = loadConfig({ file: null, env: configuredEnv })

    const message = secretValues.join(' and ')
    const scrubbed = redactSecrets(message, config)

    for (const secret of secretValues) {
      expect(scrubbed).not.toContain(secret)
    }
  })

  it('leaves a string with no secrets in it alone', () => {
    const config = loadConfig({ file: null, env: configuredEnv })

    expect(redactSecrets('nothing to see here', config)).toBe('nothing to see here')
  })

  it('ignores empty secret values so it cannot scrub everything', () => {
    const config = loadConfig({ file: null, env: {} as NodeJS.ProcessEnv })

    expect(redactSecrets('a plain message', config)).toBe('a plain message')
  })

  it('redacts a longer secret whole when a shorter secret is a prefix of it', () => {
    const shorterSecret = 'tok-shared'
    const longerSecret = `${shorterSecret}-with-a-tail`
    const config = loadConfig({
      file: { llm: { provider: 'anthropic' } },
      env: {
        ANTHROPIC_API_KEY: shorterSecret,
        GITHUB_TOKEN: longerSecret,
      } as NodeJS.ProcessEnv,
    })

    const scrubbed = redactSecrets(`upstream rejected ${longerSecret}`, config)

    expect(scrubbed).toBe(`upstream rejected ${REDACTED}`)
    expect(scrubbed).not.toContain('-with-a-tail')
  })

  /**
   * Deliberate boundary, not a gap. Recognising a secret through an encoding does not
   * terminate: percent-encoding in either hex case, a partly encoded value, JSON escaping,
   * whatever an upstream SDK does. The encodings are handled by removing the places they
   * can occur, which the logging tests cover. This test exists so that reintroducing
   * pattern matching here is a deliberate act rather than a quiet one.
   */
  it('matches literally, leaving an encoded form of a secret to be handled elsewhere', () => {
    const secretWithReservedChars = 'access+token/value'
    const config = loadConfig({
      file: null,
      env: { CAROLINE_AUTH_CLIENT_SECRET: secretWithReservedChars } as NodeJS.ProcessEnv,
    })

    const encoded = encodeURIComponent(secretWithReservedChars)

    expect(redactSecrets(encoded, config)).toBe(encoded)
    expect(redactSecrets(secretWithReservedChars, config)).toBe(REDACTED)
  })

  it('still matches the literal characters of a secret case-sensitively', () => {
    const config = loadConfig({
      file: null,
      env: { CAROLINE_AUTH_CLIENT_SECRET: 'MixedCaseToken' } as NodeJS.ProcessEnv,
    })

    expect(redactSecrets('mixedcasetoken', config)).toBe('mixedcasetoken')
  })

  it('treats regular expression syntax in a secret as literal text', () => {
    const config = loadConfig({
      file: null,
      env: { CAROLINE_AUTH_CLIENT_SECRET: 'a.c*d' } as NodeJS.ProcessEnv,
    })

    expect(redactSecrets('abcxd', config)).toBe('abcxd')
    expect(redactSecrets('a.c*d', config)).toBe(REDACTED)
  })
})

/**
 * Spec 09, criterion 6, for the values the configuration never holds: the OAuth tokens arrive from
 * Google at runtime, so the scrubber has to be told about them.
 */
describe('runtime secrets', () => {
  function freshConfig() {
    return loadConfig({ file: null, env: configuredEnv })
  }

  it('scrubs a token that never came from the configuration', () => {
    const config = freshConfig()
    registerRuntimeSecret(config, 'refresh-token-value')

    expect(redactSecrets('using refresh-token-value now', config)).toBe(`using ${REDACTED} now`)
  })

  it('ignores an absent or empty value rather than scrubbing every gap in a string', () => {
    const config = freshConfig()
    registerRuntimeSecret(config, null)
    registerRuntimeSecret(config, '')

    expect(redactSecrets('nothing to hide', config)).toBe('nothing to hide')
  })

  /**
   * An access token is replaced every hour. Unbounded, the list would grow for the life of the
   * process and the scrubber would scan all of it for every log line.
   */
  it('keeps the list of rotating tokens bounded', () => {
    const config = freshConfig()
    for (let index = 0; index < 40; index += 1) {
      registerRuntimeSecret(config, `access-token-${index}`, 'rotating')
    }

    expect(
      scrubbedValues(config).filter((value) => value.startsWith('access-token-')),
    ).toHaveLength(8)
    // The recent ones are the ones that could still turn up in a line.
    expect(redactSecrets('access-token-39', config)).toBe(REDACTED)
    expect(redactSecrets('access-token-0', config)).toBe('access-token-0')
  })

  /**
   * The refresh token is the more sensitive of the pair and the one still worth scrubbing an hour
   * later, so the access tokens it goes on producing must not evict it.
   */
  it('never drops a lasting token to make room for a rotating one', () => {
    const config = freshConfig()
    registerRuntimeSecret(config, 'refresh-token-value', 'lasting')
    for (let index = 0; index < 40; index += 1) {
      registerRuntimeSecret(config, `access-token-${index}`, 'rotating')
    }

    expect(redactSecrets('refresh-token-value', config)).toBe(REDACTED)
  })

  it('keeps the environment secrets whatever else arrives', () => {
    const config = freshConfig()
    for (let index = 0; index < 40; index += 1) {
      registerRuntimeSecret(config, `access-token-${index}`, 'rotating')
    }

    for (const secret of scrubbedValues(config)) {
      expect(redactSecrets(secret, config)).toBe(REDACTED)
    }
    expect(scrubbedValues(config)).toContain('ghp_supersecret')
  })
})

import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config/load.js'
import { redactConfig, redactSecrets, REDACTED } from '../../src/config/redact.js'

const configuredEnv = {
  ANTHROPIC_API_KEY: 'sk-ant-supersecret',
  GITHUB_TOKEN: 'ghp_supersecret',
  GOOGLE_CLIENT_SECRET: 'google-supersecret',
  CAROLINE_ACCESS_TOKEN: 'access-supersecret',
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
    expect(redacted.server.accessToken).toBe(REDACTED)
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

  it('redacts the percent-encoded form of a secret as well as the literal one', () => {
    const secretWithReservedChars = 'access+token/value'
    const config = loadConfig({
      file: null,
      env: { CAROLINE_ACCESS_TOKEN: secretWithReservedChars } as NodeJS.ProcessEnv,
    })

    const encoded = encodeURIComponent(secretWithReservedChars)
    const scrubbed = redactSecrets(`GET /api/health?token=${encoded}`, config)

    expect(scrubbed).toBe(`GET /api/health?token=${REDACTED}`)
  })
})

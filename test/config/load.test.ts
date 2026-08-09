import { describe, expect, it } from 'vitest'
import { loadConfig, ConfigError } from '../../src/config/load.js'

const noEnv = {} as NodeJS.ProcessEnv

describe('loadConfig defaults', () => {
  it('produces a usable configuration from nothing at all', () => {
    const config = loadConfig({ file: null, env: noEnv })

    expect(config.server.host).toBe('127.0.0.1')
    expect(config.server.port).toBe(5123)
    expect(config.server.accessToken).toBeNull()
    expect(config.privacy.llmContent).toBe('snippet')
    expect(config.privacy.storeContent).toBe('metadata')
    expect(config.privacy.allowFullContentToRemoteProvider).toBe(false)
    expect(config.llm.provider).toBe('none')
    // Spec 02's default: a week of silence is when a waiting item becomes a chase.
    expect(config.tasks.waitingStaleDays).toBe(7)
  })

  it('takes a waiting staleness threshold from the file', () => {
    const config = loadConfig({ file: { tasks: { waitingStaleDays: 3 } }, env: noEnv })

    expect(config.tasks.waitingStaleDays).toBe(3)
  })

  it('rejects a threshold of zero days, which would call everything stale at once', () => {
    expect(() => loadConfig({ file: { tasks: { waitingStaleDays: 0 } }, env: noEnv })).toThrow(
      ConfigError,
    )
  })

  it('rejects a threshold that is not a whole number of days', () => {
    expect(() => loadConfig({ file: { tasks: { waitingStaleDays: 1.5 } }, env: noEnv })).toThrow(
      ConfigError,
    )
  })

  it('reports every integration as not configured when no credentials are present', () => {
    const config = loadConfig({ file: null, env: noEnv })

    expect(config.integrations.github.configured).toBe(false)
    expect(config.integrations.google.configured).toBe(false)
    expect(config.llm.configured).toBe(false)
  })
})

describe('loadConfig precedence', () => {
  it('lets the file override the defaults', () => {
    const config = loadConfig({
      file: { server: { port: 6000 }, privacy: { snippetChars: 120 } },
      env: noEnv,
    })

    expect(config.server.port).toBe(6000)
    expect(config.privacy.snippetChars).toBe(120)
  })

  it('lets the environment override the file', () => {
    const config = loadConfig({
      file: { server: { port: 6000 } },
      env: { CAROLINE_PORT: '7000' } as NodeJS.ProcessEnv,
    })

    expect(config.server.port).toBe(7000)
  })

  it('reads secrets from the environment only', () => {
    const config = loadConfig({
      file: { llm: { provider: 'anthropic' } },
      env: { ANTHROPIC_API_KEY: 'sk-ant-secret', GITHUB_TOKEN: 'ghp_secret' } as NodeJS.ProcessEnv,
    })

    expect(config.llm.apiKey).toBe('sk-ant-secret')
    expect(config.integrations.github.token).toBe('ghp_secret')
    expect(config.integrations.github.configured).toBe(true)
  })

  it('takes the key belonging to the selected provider and no other', () => {
    const config = loadConfig({
      file: { llm: { provider: 'openai' } },
      env: {
        ANTHROPIC_API_KEY: 'sk-ant-secret',
        OPENAI_API_KEY: 'sk-oai-secret',
      } as NodeJS.ProcessEnv,
    })

    expect(config.llm.apiKey).toBe('sk-oai-secret')
  })

  it('leaves the key null when no provider is selected', () => {
    const config = loadConfig({
      file: null,
      env: { ANTHROPIC_API_KEY: 'sk-ant-secret' } as NodeJS.ProcessEnv,
    })

    expect(config.llm.apiKey).toBeNull()
    expect(config.llm.configured).toBe(false)
  })
})

describe('loadConfig validation', () => {
  it('names the offending path when a value is the wrong shape', () => {
    expect(() =>
      loadConfig({ file: { privacy: { llmContent: 'everything' } }, env: noEnv }),
    ).toThrow(/privacy\.llmContent/)
  })

  it('rejects a port that is not a number', () => {
    expect(() =>
      loadConfig({ file: null, env: { CAROLINE_PORT: 'abc' } as NodeJS.ProcessEnv }),
    ).toThrow(/server\.port/)
  })

  it('rejects an LLM base URL carrying credentials in the config file', () => {
    expect(() =>
      loadConfig({ file: { llm: { baseUrl: 'https://user:pass@llm.example.com' } }, env: noEnv }),
    ).toThrow(/llm\.baseUrl/)
  })

  it('rejects an LLM base URL carrying credentials in the environment', () => {
    expect(() =>
      loadConfig({
        file: null,
        env: { CAROLINE_LLM_BASE_URL: 'https://user:pass@llm.example.com' } as NodeJS.ProcessEnv,
      }),
    ).toThrow(/llm\.baseUrl/)
  })

  it('rejects an LLM base URL carrying a bare username', () => {
    expect(() =>
      loadConfig({ file: { llm: { baseUrl: 'https://user@llm.example.com' } }, env: noEnv }),
    ).toThrow(/llm\.baseUrl/)
  })

  it('rejects an LLM base URL from the environment that is not a URL at all', () => {
    expect(() =>
      loadConfig({
        file: null,
        env: { CAROLINE_LLM_BASE_URL: 'not a url' } as NodeJS.ProcessEnv,
      }),
    ).toThrow(/llm\.baseUrl/)
  })

  it('accepts a credential-free LLM base URL from either source', () => {
    const fromFile = loadConfig({
      file: { llm: { baseUrl: 'http://127.0.0.1:11434' } },
      env: noEnv,
    })
    const fromEnv = loadConfig({
      file: null,
      env: { CAROLINE_LLM_BASE_URL: 'https://llm.example.com/v1' } as NodeJS.ProcessEnv,
    })

    expect(fromFile.llm.baseUrl).toBe('http://127.0.0.1:11434')
    expect(fromEnv.llm.baseUrl).toBe('https://llm.example.com/v1')
  })

  it('throws a ConfigError rather than a bare Error', () => {
    try {
      loadConfig({ file: { privacy: { snippetChars: -1 } }, env: noEnv })
      expect.unreachable('expected a ConfigError')
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError)
    }
  })
})

describe('loadConfig secret placement (spec 09: keys come from the environment only)', () => {
  it('fails when an LLM key is present in the config file', () => {
    expect(() => loadConfig({ file: { llm: { apiKey: 'sk-in-file' } }, env: noEnv })).toThrow(
      /llm\.apiKey/,
    )
  })

  it('names the environment variable to use instead', () => {
    expect(() => loadConfig({ file: { llm: { apiKey: 'sk-in-file' } }, env: noEnv })).toThrow(
      /ANTHROPIC_API_KEY|OPENAI_API_KEY|environment/,
    )
  })

  it('fails when a GitHub token is present in the config file', () => {
    expect(() =>
      loadConfig({ file: { integrations: { github: { token: 'ghp_in_file' } } }, env: noEnv }),
    ).toThrow(/integrations\.github\.token/)
  })

  it('fails when the server access token is present in the config file', () => {
    expect(() => loadConfig({ file: { server: { accessToken: 'in-file' } }, env: noEnv })).toThrow(
      /server\.accessToken/,
    )
  })
})

describe('loadConfig startup guards', () => {
  it('fails when full content would go to a remote provider without the allow flag', () => {
    expect(() =>
      loadConfig({
        file: { privacy: { llmContent: 'full' }, llm: { provider: 'anthropic' } },
        env: { ANTHROPIC_API_KEY: 'sk-ant' } as NodeJS.ProcessEnv,
      }),
    ).toThrow(
      /llmContent.*allowFullContentToRemoteProvider|allowFullContentToRemoteProvider.*llmContent/s,
    )
  })

  it('allows full content to a remote provider once the flag is set', () => {
    const config = loadConfig({
      file: {
        privacy: { llmContent: 'full', allowFullContentToRemoteProvider: true },
        llm: { provider: 'anthropic' },
      },
      env: { ANTHROPIC_API_KEY: 'sk-ant' } as NodeJS.ProcessEnv,
    })

    expect(config.privacy.llmContent).toBe('full')
  })

  it('allows full content to a local provider without the flag', () => {
    const config = loadConfig({
      file: { privacy: { llmContent: 'full' }, llm: { provider: 'ollama' } },
      env: noEnv,
    })

    expect(config.privacy.llmContent).toBe('full')
    expect(config.llm.isLocal).toBe(true)
  })

  it('fails when binding to a non-loopback address without an access token', () => {
    expect(() => loadConfig({ file: { server: { host: '0.0.0.0' } }, env: noEnv })).toThrow(
      /access token/i,
    )
  })

  it('allows a non-loopback bind once an access token is set in the environment', () => {
    const config = loadConfig({
      file: { server: { host: '0.0.0.0' } },
      env: { CAROLINE_ACCESS_TOKEN: 'a-token' } as NodeJS.ProcessEnv,
    })

    expect(config.server.host).toBe('0.0.0.0')
  })

  it('treats ::1 and localhost as loopback', () => {
    for (const host of ['::1', 'localhost']) {
      expect(() => loadConfig({ file: { server: { host } }, env: noEnv })).not.toThrow()
    }
  })
})

import { describe, expect, it } from 'vitest'
import { loadConfig, ConfigError } from '../../src/config/load.js'

const noEnv = {} as NodeJS.ProcessEnv

describe('loadConfig defaults', () => {
  it('produces a usable configuration from nothing at all', () => {
    const config = loadConfig({ file: null, env: noEnv })

    expect(config.server.host).toBe('127.0.0.1')
    expect(config.server.port).toBe(5123)
    expect(config.server.publicUrl).toBeNull()
    expect(config.authRequired).toBe(false)
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

  /** Spec 02: if you asked for changes, the changes arriving are your cue. */
  it('returns a pull request to review on new commits by default', () => {
    expect(
      loadConfig({ file: null, env: noEnv }).integrations.github.returnToReviewOnNewCommits,
    ).toBe(true)
  })

  it('lets that be turned off, so only an explicit re-request returns it', () => {
    const config = loadConfig({
      file: { integrations: { github: { returnToReviewOnNewCommits: false } } },
      env: noEnv,
    })

    expect(config.integrations.github.returnToReviewOnNewCommits).toBe(false)
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

describe('LLM budgets and overrides', () => {
  it('defaults the budgets to what spec 03 states', () => {
    const config = loadConfig({ file: null, env: noEnv })

    expect(config.llm.maxTokens).toBe(4096)
    expect(config.llm.timeoutMs).toBe(60_000)
    expect(config.llm.overrides).toEqual({ classification: null, chat: null })
  })

  it('rejects a timeout short enough that no call could finish inside it', () => {
    expect(() => loadConfig({ file: { llm: { timeoutMs: 10 } }, env: noEnv })).toThrow(ConfigError)
  })

  it('rejects an override field the schema does not define', () => {
    expect(() =>
      loadConfig({ file: { llm: { overrides: { chat: { modle: 'typo' } } } }, env: noEnv }),
    ).toThrow(/llm\.overrides\.chat/)
  })

  it('refuses an API key hidden in an override, as it does in the base config', () => {
    expect(() =>
      loadConfig({
        file: { llm: { overrides: { chat: { apiKey: 'sk-ant-in-the-file' } } } },
        env: noEnv,
      }),
    ).toThrow(/llm\.overrides\.chat\.apiKey/)
  })

  it('lets an override clear the base model rather than inherit it', () => {
    const config = loadConfig({
      file: { llm: { provider: 'ollama', model: 'llama', overrides: { chat: { model: null } } } },
      env: noEnv,
    })

    expect(config.llm.overrides.chat?.model).toBeNull()
    expect(config.llm.overrides.chat?.configured).toBe(false)
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

  /**
   * The guard has to look at every provider that could be used, not only the base one.
   * Content sent under a chat override leaves the machine just the same.
   */
  it('fails when an override names a remote provider under a local base', () => {
    expect(() =>
      loadConfig({
        file: {
          privacy: { llmContent: 'full' },
          llm: {
            provider: 'ollama',
            model: 'llama',
            overrides: { chat: { provider: 'anthropic', model: 'claude' } },
          },
        },
        env: { ANTHROPIC_API_KEY: 'sk-ant' } as NodeJS.ProcessEnv,
      }),
    ).toThrow(/llm\.overrides\.chat\.provider/)
  })

  // The old "an access token protects a non-loopback bind" guard is gone (spec 13): a
  // non-loopback bind now requires a login, not a shared secret. See "the auth boundary"
  // describe block below for its replacement.

  it('fails at startup when CAROLINE_ACCESS_TOKEN is set in the environment', () => {
    expect(() =>
      loadConfig({ file: null, env: { CAROLINE_ACCESS_TOKEN: 'a-token' } as NodeJS.ProcessEnv }),
    ).toThrow(/CAROLINE_ACCESS_TOKEN/)
  })

  it('still loads with CAROLINE_ACCESS_TOKEN set when runtimeChecks is false', () => {
    const config = loadConfig({
      file: null,
      env: { CAROLINE_ACCESS_TOKEN: 'a-token' } as NodeJS.ProcessEnv,
      runtimeChecks: false,
    })

    expect(config.authRequired).toBe(false)
  })

  it('treats ::1 and localhost as loopback', () => {
    for (const host of ['::1', 'localhost']) {
      expect(() => loadConfig({ file: { server: { host } }, env: noEnv })).not.toThrow()
    }
  })
})

/** Spec 13, criteria 1, 3, 4, 5, 31 and 32: the boundary decision and what startup refuses. */
describe('the auth boundary', () => {
  /** A configuration that satisfies every runtime refusal on its own: only the shape decides. */
  const allowed = { allow: ['owner@example.com'], provider: { clientId: 'client-id' } }

  it('leaves auth not required for a loopback bind with no publicUrl and auth.mode at auto (criterion 2)', () => {
    expect(loadConfig({ file: null, env: noEnv }).authRequired).toBe(false)
  })

  it('requires auth once the bind is not loopback, even fully configured (criterion 1, rule 1)', () => {
    const config = loadConfig({
      file: {
        server: { host: '0.0.0.0', publicUrl: 'https://caroline.example.com' },
        auth: allowed,
      },
      env: noEnv,
    })

    expect(config.authRequired).toBe(true)
  })

  it('requires auth once server.publicUrl is set, whatever the bind is (criterion 1, rule 2)', () => {
    const config = loadConfig({
      file: { server: { publicUrl: 'http://127.0.0.1:5123' }, auth: allowed },
      env: noEnv,
    })

    expect(config.authRequired).toBe(true)
  })

  it('requires auth on a loopback bind once auth.mode is required (criterion 1, rule 3; criterion 31)', () => {
    const config = loadConfig({
      file: { auth: { ...allowed, mode: 'required' } },
      env: noEnv,
    })

    expect(config.authRequired).toBe(true)
  })

  it('leaves the same configuration not requiring auth when auth.mode stays at auto (criterion 31)', () => {
    const config = loadConfig({ file: { auth: allowed }, env: noEnv })

    expect(config.authRequired).toBe(false)
  })

  it('treats 0.0.0.0 and :: as non-loopback (criterion 5)', () => {
    for (const host of ['0.0.0.0', '::']) {
      const config = loadConfig({
        file: { server: { host, publicUrl: 'https://caroline.example.com' }, auth: allowed },
        env: noEnv,
      })
      expect(config.authRequired, host).toBe(true)
    }
  })

  it('fails at startup when no provider is configured and auth is required (criterion 3)', () => {
    expect(() =>
      loadConfig({ file: { auth: { mode: 'required', allow: allowed.allow } }, env: noEnv }),
    ).toThrow(/auth\.provider\.clientId/)
  })

  it('fails at startup when the allowlist is empty and auth is required (criterion 3)', () => {
    expect(() =>
      loadConfig({
        file: { auth: { mode: 'required', provider: allowed.provider } },
        env: noEnv,
      }),
    ).toThrow(/auth\.allow/)
  })

  it('fails at startup when server.publicUrl is unset and the bind is not loopback (criterion 3)', () => {
    expect(() =>
      loadConfig({ file: { server: { host: '0.0.0.0' }, auth: allowed }, env: noEnv }),
    ).toThrow(/server\.publicUrl/)
  })

  it('does not fail for want of a public URL on a loopback bind (criterion 3)', () => {
    expect(() =>
      loadConfig({ file: { auth: { ...allowed, mode: 'required' } }, env: noEnv }),
    ).not.toThrow()
  })

  it('requires auth whatever the bind is once server.publicUrl is set (criterion 4)', () => {
    const config = loadConfig({
      file: {
        server: { host: '127.0.0.1', publicUrl: 'https://caroline.example.com' },
        auth: allowed,
      },
      env: noEnv,
    })

    expect(config.authRequired).toBe(true)
  })

  it('fails at startup when server.publicUrl is not https and the bind is not loopback (criterion 4)', () => {
    expect(() =>
      loadConfig({
        file: {
          server: { host: '0.0.0.0', publicUrl: 'http://caroline.example.com' },
          auth: allowed,
        },
        env: noEnv,
      }),
    ).toThrow(/https/)
  })

  it('fails at startup for a plaintext public URL on a loopback host, where the bind is not loopback (criterion 4)', () => {
    // The exact case the bind half of the https test exists for: the URL's own host says
    // nothing about who can reach the socket.
    expect(() =>
      loadConfig({
        file: {
          server: { host: '0.0.0.0', publicUrl: 'http://127.0.0.1:5123' },
          auth: allowed,
        },
        env: noEnv,
      }),
    ).toThrow(/https/)
  })

  it('accepts a plaintext public URL where both it and the bind are loopback (criterion 4)', () => {
    const config = loadConfig({
      file: {
        server: { host: '127.0.0.1', publicUrl: 'http://localhost:5123' },
        auth: allowed,
      },
      env: noEnv,
    })

    expect(config.authRequired).toBe(true)
    expect(config.server.publicUrl).toBe('http://localhost:5123')
  })

  it('requires an https public URL where the bind is not loopback even though the URL host is (criterion 4)', () => {
    expect(() =>
      loadConfig({
        file: { server: { host: '::', publicUrl: 'https://localhost:5123' }, auth: allowed },
        env: noEnv,
      }),
    ).not.toThrow()
  })

  it('is skipped entirely when runtimeChecks is false, for every refusal at once (criterion 32)', () => {
    const config = loadConfig({
      file: { server: { host: '0.0.0.0' }, auth: { mode: 'required' } },
      env: { CAROLINE_ACCESS_TOKEN: 'a-token' } as NodeJS.ProcessEnv,
      runtimeChecks: false,
    })

    expect(config.authRequired).toBe(true)
    expect(config.auth.provider.clientId).toBeNull()
    expect(config.auth.allow).toEqual([])
    expect(config.server.publicUrl).toBeNull()
  })

  it('still bans server.accessToken in the file when runtimeChecks is false (criterion 32)', () => {
    expect(() =>
      loadConfig({
        file: { server: { accessToken: 'in-file' } },
        env: noEnv,
        runtimeChecks: false,
      }),
    ).toThrow(/server\.accessToken/)
  })
})

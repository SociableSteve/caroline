/**
 * The chat settings, and the one fact about a model that decides whether chat can change anything.
 * Spec 07's limits and spec 03's graceful degradation both come out of here.
 */
import { describe, expect, it } from 'vitest'
import { ConfigError, loadConfig } from '../../src/config/load.js'

function load(file: unknown, env: Record<string, string> = {}) {
  return loadConfig({ file, env: env as NodeJS.ProcessEnv })
}

describe('the chat settings', () => {
  it('default to spec 07’s numbers', () => {
    expect(load(null).chat).toMatchObject({ maxToolCalls: 25, bulkConfirmThreshold: 10 })
  })

  it('can be changed', () => {
    const config = load({ chat: { maxToolCalls: 5, bulkConfirmThreshold: 3, contextMessages: 10 } })

    expect(config.chat).toEqual({
      maxToolCalls: 5,
      bulkConfirmThreshold: 3,
      contextMessages: 10,
    })
  })

  it('refuses a tool-call cap of zero, which would be chat that cannot do anything', () => {
    expect(() => load({ chat: { maxToolCalls: 0 } })).toThrow(ConfigError)
  })

  it('refuses a threshold of zero, which would confirm every single change', () => {
    expect(() => load({ chat: { bulkConfirmThreshold: 0 } })).toThrow(ConfigError)
  })

  it('refuses a field it does not know, rather than ignoring a typo', () => {
    expect(() => load({ chat: { maxToolcalls: 5 } })).toThrow(/maxToolcalls/)
  })
})

describe('whether a model can be given tools', () => {
  /** The hosted providers take tools from every model they serve. */
  it('is true for the hosted providers', () => {
    expect(
      load({ llm: { provider: 'anthropic', model: 'a-model' } }, { ANTHROPIC_API_KEY: 'key' }).llm
        .supportsTools,
    ).toBe(true)
    expect(
      load({ llm: { provider: 'openai', model: 'a-model' } }, { OPENAI_API_KEY: 'key' }).llm
        .supportsTools,
    ).toBe(true)
  })

  /**
   * Ollama's answer is the model's, not the server's, so it is false until the operator says
   * otherwise: chat that says it cannot make changes is recoverable, and chat that claims changes it
   * could not make is not.
   */
  it('is false for ollama until it is declared', () => {
    expect(load({ llm: { provider: 'ollama', model: 'a-model' } }).llm.supportsTools).toBe(false)
  })

  it('can be declared for ollama', () => {
    expect(
      load({ llm: { provider: 'ollama', model: 'a-model', supportsTools: true } }).llm
        .supportsTools,
    ).toBe(true)
  })

  it('can be turned off for a hosted provider, for a model that cannot', () => {
    expect(
      load(
        { llm: { provider: 'anthropic', model: 'a-model', supportsTools: false } },
        { ANTHROPIC_API_KEY: 'key' },
      ).llm.supportsTools,
    ).toBe(false)
  })

  it('is inherited by an override that stays on the same provider', () => {
    const config = load({
      llm: {
        provider: 'ollama',
        model: 'a-model',
        supportsTools: true,
        overrides: { chat: { model: 'a-bigger-model' } },
      },
    })

    expect(config.llm.overrides.chat?.supportsTools).toBe(true)
  })

  /** As for the base URL: it is a fact about a provider's models, not about the configuration. */
  it('is not inherited across a change of provider', () => {
    const config = load(
      {
        llm: {
          provider: 'ollama',
          model: 'a-model',
          supportsTools: true,
          overrides: { chat: { provider: 'anthropic', model: 'a-hosted-model' } },
        },
      },
      { ANTHROPIC_API_KEY: 'key' },
    )

    expect(config.llm.overrides.chat).toMatchObject({
      provider: 'anthropic',
      supportsTools: true,
    })
  })

  it('can be declared on the chat override alone', () => {
    const config = load({
      llm: {
        provider: 'ollama',
        model: 'a-model',
        overrides: { chat: { supportsTools: true } },
      },
    })

    expect(config.llm.supportsTools).toBe(false)
    expect(config.llm.overrides.chat?.supportsTools).toBe(true)
  })
})

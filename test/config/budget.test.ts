/**
 * `llm.budget`: the shape, the defaults that keep it strictly additive, and the refusals that stop
 * a mistake reading as unlimited. Spec 03, criteria 8, 9 and 10.
 */
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config/load.js'

const noEnvironment = {} as NodeJS.ProcessEnv

function load(file: unknown) {
  return loadConfig({ file, env: { ANTHROPIC_API_KEY: 'k' } as NodeJS.ProcessEnv })
}

describe('the default, spec 03 criterion 8', () => {
  it('leaves every provider unlimited when no budget block is written', () => {
    const config = loadConfig({ file: {}, env: noEnvironment })

    expect(config.llm.budget.limits).toEqual({
      anthropic: 'unlimited',
      openai: 'unlimited',
      ollama: 'unlimited',
    })
    expect(config.llm.budget.allowances).toEqual({
      anthropic: null,
      openai: null,
      ollama: null,
    })
  })

  it('defaults the currency and the period, so a block naming one provider is enough', () => {
    const config = load({
      llm: { provider: 'anthropic', model: 'claude-sonnet-5', budget: { anthropic: 10 } },
    })

    expect(config.llm.budget.currency).toBe('USD')
    expect(config.llm.budget.period).toBe('month')
    expect(config.llm.budget.limits.openai).toBe('unlimited')
  })

  it('leaves a provider it names no entry for unlimited', () => {
    const config = load({
      llm: { provider: 'anthropic', model: 'claude-sonnet-5', budget: { openai: 5 } },
    })

    expect(config.llm.budget.limits.anthropic).toBe('unlimited')
    expect(config.llm.budget.allowances.anthropic).toBeNull()
  })
})

describe('the allowance, spec 03 criterion 11', () => {
  it('is what the ceiling buys at the configured model output rate', () => {
    // claude-sonnet-5 is $10 per million output tokens, so $30 buys three million.
    const config = load({
      llm: {
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        budget: { currency: 'USD', anthropic: 30 },
      },
    })

    expect(config.llm.budget.allowances.anthropic).toBe(3_000_000)
  })

  it('is priced at the dearest model configured for that provider, so the ceiling stays a bound', () => {
    // The base runs the cheap model and chat the dear one. Pricing the allowance at the cheap one
    // would let a run of chat turns spend past the ceiling before the count caught up.
    const cheapOnly = load({
      llm: {
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        budget: { currency: 'USD', anthropic: 30 },
      },
    })
    const withDearOverride = load({
      llm: {
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        budget: { currency: 'USD', anthropic: 30 },
        overrides: { chat: { model: 'claude-opus-5' } },
      },
    })

    expect(cheapOnly.llm.budget.allowances.anthropic).toBe(6_000_000)
    expect(withDearOverride.llm.budget.allowances.anthropic).toBe(1_200_000)
  })

  it('is not enforced for a provider no configured settings name', () => {
    const config = load({
      llm: { provider: 'anthropic', model: 'claude-sonnet-5', budget: { openai: 5 } },
    })

    expect(config.llm.budget.limits.openai).toBe(5)
    expect(config.llm.budget.allowances.openai).toBeNull()
  })

  it('never bounds ollama, which is priced at zero', () => {
    // An unbounded allowance and nothing to enforce are the same thing, so there is one spelling
    // of it rather than two. Spec 03: neither the default nor an explicit figure bills for a local
    // provider.
    const config = loadConfig({
      file: { llm: { provider: 'ollama', model: 'llama3.1:8b', budget: { ollama: 5 } } },
      env: noEnvironment,
    })

    expect(config.llm.budget.limits.ollama).toBe(5)
    expect(config.llm.budget.allowances.ollama).toBeNull()
  })
})

describe('a model the price table does not carry, spec 03 criterion 9', () => {
  const file = (limit: unknown) => ({
    llm: { provider: 'anthropic', model: 'claude-from-the-future', budget: { anthropic: limit } },
  })

  it('stops startup where that provider has a numeric ceiling, naming what is involved', () => {
    expect(() => load(file(20))).toThrow(
      /claude-from-the-future.*anthropic.*llm\.budget\.anthropic|llm\.budget\.anthropic.*claude-from-the-future/s,
    )
  })

  it('starts where that provider is unlimited, so a stale table cannot break an uncapped install', () => {
    expect(() => load(file('unlimited'))).not.toThrow()
    expect(load(file('unlimited')).llm.budget.allowances.anthropic).toBeNull()
  })

  it('starts with no budget block at all', () => {
    expect(() =>
      load({ llm: { provider: 'anthropic', model: 'claude-from-the-future' } }),
    ).not.toThrow()
  })

  it('does not stop the deletion command, which starts no server and calls no provider', () => {
    expect(() =>
      loadConfig({ file: file(20), env: noEnvironment, runtimeChecks: false }),
    ).not.toThrow()
  })
})

describe('the refusals, spec 03 criterion 10', () => {
  const withLimit = (limit: unknown) => ({
    llm: { provider: 'anthropic', model: 'claude-sonnet-5', budget: { anthropic: limit } },
  })

  it('refuses 0, which is ambiguous between no cap and no spending', () => {
    expect(() => load(withLimit(0))).toThrow(/llm\.budget\.anthropic/)
  })

  it('refuses a negative amount', () => {
    expect(() => load(withLimit(-1))).toThrow(/llm\.budget\.anthropic/)
  })

  it('refuses a non-finite amount', () => {
    expect(() => load(withLimit(Number.POSITIVE_INFINITY))).toThrow(/llm\.budget\.anthropic/)
    expect(() => load(withLimit(Number.NaN))).toThrow(/llm\.budget\.anthropic/)
  })

  it('refuses any string but "unlimited"', () => {
    expect(() => load(withLimit('none'))).toThrow(/llm\.budget\.anthropic/)
    expect(() => load(withLimit('20'))).toThrow(/llm\.budget\.anthropic/)
  })

  it('refuses null, which is the value an absent entry would have defaulted to', () => {
    expect(() => load(withLimit(null))).toThrow(/llm\.budget\.anthropic/)
  })

  it('accepts "unlimited", which is the literal and the default', () => {
    expect(load(withLimit('unlimited')).llm.budget.limits.anthropic).toBe('unlimited')
  })

  it('refuses an unrecognised currency, period or key', () => {
    expect(() => load({ llm: { budget: { currency: 'CHF' } } })).toThrow(/currency/)
    expect(() => load({ llm: { budget: { period: 'week' } } })).toThrow(/period/)
    expect(() => load({ llm: { budget: { gemini: 5 } } })).toThrow(/budget/)
  })
})

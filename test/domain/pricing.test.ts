import { describe, expect, it } from 'vitest'
import {
  estimateCost,
  exchangeRates,
  modelPrices,
  priceCheckedOn,
  priceFor,
  tokenAllowance,
} from '../../src/domain/pricing.js'

describe('the committed price table', () => {
  it('prices every model it carries in USD per million tokens, with the date it was checked', () => {
    for (const [provider, models] of Object.entries(modelPrices)) {
      for (const [model, price] of Object.entries(models)) {
        const where = `${provider}/${model}`

        expect(price.inputPerMillionUsd, where).toBeGreaterThan(0)
        expect(price.outputPerMillionUsd, where).toBeGreaterThanOrEqual(price.inputPerMillionUsd)
        expect(price.checkedOn, where).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      }
    }
  })

  it('prices ollama at zero for any model, so a local provider is never billed', () => {
    // Spec 03: the price table's shape follows `llm_calls.provider`, but a local model's name is
    // whatever the operator pulled, so ollama is answered by rule rather than by enumeration.
    expect(priceFor('ollama', 'llama3.1:8b')).toMatchObject({
      inputPerMillionUsd: 0,
      outputPerMillionUsd: 0,
    })
  })

  it('does not know a model it does not carry', () => {
    expect(priceFor('anthropic', 'claude-not-a-model')).toBeNull()
  })

  it('states one exchange rate per currency, USD being the base and needing none', () => {
    expect(exchangeRates.USD).toMatchObject({ perUsd: 1, checkedOn: null })
    expect(exchangeRates.GBP.perUsd).toBeGreaterThan(0)
    expect(exchangeRates.GBP.checkedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('estimateCost, spec 03 criterion 15', () => {
  const price = { inputPerMillionUsd: 3, outputPerMillionUsd: 15, checkedOn: '2026-08-24' }

  it('prices input and output at their own rates', () => {
    expect(estimateCost(price, { inputTokens: 1_000_000, outputTokens: 1_000_000 }, 'USD')).toBe(18)
  })

  it('converts into the configured currency at the committed rate', () => {
    const usd = estimateCost(price, { inputTokens: 2_000_000, outputTokens: 0 }, 'USD')
    const gbp = estimateCost(price, { inputTokens: 2_000_000, outputTokens: 0 }, 'GBP')

    expect(gbp).toBeCloseTo(usd * exchangeRates.GBP.perUsd, 10)
  })
})

describe('priceCheckedOn, spec 03 criterion 15', () => {
  it('is the price date where no conversion is involved', () => {
    expect(
      priceCheckedOn(
        { inputPerMillionUsd: 1, outputPerMillionUsd: 2, checkedOn: '2026-08-24' },
        'USD',
      ),
    ).toBe('2026-08-24')
  })

  it('is the older of the price date and the rate date, because an estimate is only as fresh as its stalest input', () => {
    const stalePrice = { inputPerMillionUsd: 1, outputPerMillionUsd: 2, checkedOn: '2020-01-01' }
    const freshPrice = { inputPerMillionUsd: 1, outputPerMillionUsd: 2, checkedOn: '2099-01-01' }

    expect(priceCheckedOn(stalePrice, 'GBP')).toBe('2020-01-01')
    expect(priceCheckedOn(freshPrice, 'GBP')).toBe(exchangeRates.GBP.checkedOn)
  })

  it('ignores the rate for a free model, whose zero no conversion ever touched', () => {
    // An Ollama-only install in GBP would otherwise date its zero by an exchange rate that played
    // no part in producing it.
    const free = { inputPerMillionUsd: 0, outputPerMillionUsd: 0, checkedOn: '2026-08-24' }

    expect(priceCheckedOn(free, 'GBP')).toBe('2026-08-24')
    expect(priceCheckedOn(free, 'USD')).toBe('2026-08-24')
  })
})

describe('tokenAllowance, spec 03 criteria 11 and 12', () => {
  const price = { inputPerMillionUsd: 3, outputPerMillionUsd: 15, checkedOn: '2026-08-24' }

  it('is what the ceiling buys at the output rate, so the spend cannot exceed the ceiling', () => {
    // $15 per million output tokens, so $30 buys two million and no more, whatever the mix of
    // input and output the calls turn out to be.
    expect(tokenAllowance(30, 'USD', price)).toBe(2_000_000)
  })

  it('rounds down, because a partial token cannot be spent', () => {
    expect(tokenAllowance(1, 'USD', price)).toBe(66_666)
  })

  it('is unbounded for a free model rather than zero', () => {
    const free = { inputPerMillionUsd: 0, outputPerMillionUsd: 0, checkedOn: '2026-08-24' }
    expect(tokenAllowance(30, 'USD', free)).toBe(Number.POSITIVE_INFINITY)
  })

  it('reads the ceiling in the configured currency', () => {
    // A ceiling written in GBP buys fewer tokens than the same number written in USD, because a
    // pound is worth more than a dollar and the prices are quoted in dollars.
    expect(tokenAllowance(30, 'GBP', price)).toBeGreaterThan(tokenAllowance(30, 'USD', price))
  })
})

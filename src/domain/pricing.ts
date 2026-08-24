/**
 * What a model call costs, as a committed table rather than a fetched one. Spec 03, "The spending
 * ceiling".
 *
 * Pure: no clock, no database, no network. Spec 09 criterion 27 asserts the last of those over
 * this module's imports, because the argument for committing the prices is an argument about the
 * network posture, and a price fetch added here later would be a change to that posture made by
 * accident.
 *
 * Updating the table is an ordinary reviewed pull request. Each entry carries the date the
 * vendor's own pricing page was read, and the same goes for the exchange rates, because a figure
 * about money should say how old it is.
 */

/** The currencies a ceiling may be written in. USD is the base the table is quoted in. */
export const budgetCurrencies = ['USD', 'GBP', 'EUR'] as const
export type BudgetCurrency = (typeof budgetCurrencies)[number]

/**
 * The windows a ceiling may cover. A calendar day and a calendar month have unambiguous
 * boundaries; a week would need a start-of-week decision nothing else in the configuration makes,
 * so it is not offered rather than being guessed at.
 */
export const budgetPeriods = ['day', 'month'] as const
export type BudgetPeriod = (typeof budgetPeriods)[number]

/**
 * The literal that says a provider has no ceiling, and the default for every provider. A literal
 * rather than `null` on the config file's own stated principle that absent has to stay
 * distinguishable from set: null is what an absent field would default to, so null-means-unlimited
 * would collapse "I have chosen not to cap this" into "I never configured it". Spec 03.
 */
export const UNLIMITED = 'unlimited'

/** A provider's ceiling: a positive amount in the configured currency, or no ceiling at all. */
export type BudgetLimit = number | typeof UNLIMITED

/** The providers that can appear in `llm_calls.provider`, and so the ones a ceiling can name. */
export const pricedProviders = ['anthropic', 'openai', 'ollama'] as const
export type PricedProvider = (typeof pricedProviders)[number]

export interface ModelPrice {
  readonly inputPerMillionUsd: number
  readonly outputPerMillionUsd: number
  /** `YYYY-MM-DD`, the day the vendor's own pricing page was read. */
  readonly checkedOn: string
}

/** The tokens one call spent, which is all the estimate is ever built from. */
export interface TokenCounts {
  readonly inputTokens: number
  readonly outputTokens: number
}

/**
 * Read from platform.claude.com/docs/en/about-claude/pricing and
 * developers.openai.com/api/docs/pricing on 2026-08-24. Standard rates only: the batch discount,
 * prompt caching multipliers and fast mode are not modelled, because Caroline uses none of them
 * and a rate it never pays would only make the estimate wrong in a new way.
 *
 * Ollama is absent by design and answered by `priceFor` instead: a local model's name is whatever
 * the operator pulled, so it cannot be enumerated, and every one of them is free.
 */
export const modelPrices = {
  anthropic: {
    'claude-fable-5': { inputPerMillionUsd: 10, outputPerMillionUsd: 50, checkedOn: '2026-08-24' },
    'claude-opus-5': { inputPerMillionUsd: 5, outputPerMillionUsd: 25, checkedOn: '2026-08-24' },
    'claude-opus-4-8': { inputPerMillionUsd: 5, outputPerMillionUsd: 25, checkedOn: '2026-08-24' },
    'claude-opus-4-7': { inputPerMillionUsd: 5, outputPerMillionUsd: 25, checkedOn: '2026-08-24' },
    'claude-opus-4-6': { inputPerMillionUsd: 5, outputPerMillionUsd: 25, checkedOn: '2026-08-24' },
    'claude-opus-4-5': { inputPerMillionUsd: 5, outputPerMillionUsd: 25, checkedOn: '2026-08-24' },
    'claude-sonnet-5': { inputPerMillionUsd: 2, outputPerMillionUsd: 10, checkedOn: '2026-08-24' },
    'claude-sonnet-4-6': {
      inputPerMillionUsd: 3,
      outputPerMillionUsd: 15,
      checkedOn: '2026-08-24',
    },
    'claude-sonnet-4-5': {
      inputPerMillionUsd: 3,
      outputPerMillionUsd: 15,
      checkedOn: '2026-08-24',
    },
    'claude-haiku-4-5': { inputPerMillionUsd: 1, outputPerMillionUsd: 5, checkedOn: '2026-08-24' },
  },
  openai: {
    'gpt-5.6-sol': { inputPerMillionUsd: 4, outputPerMillionUsd: 20, checkedOn: '2026-08-24' },
    'gpt-5.6-terra': { inputPerMillionUsd: 2, outputPerMillionUsd: 12, checkedOn: '2026-08-24' },
    'gpt-5.6-luna': { inputPerMillionUsd: 0.2, outputPerMillionUsd: 1.2, checkedOn: '2026-08-24' },
    'gpt-5.5': { inputPerMillionUsd: 5, outputPerMillionUsd: 30, checkedOn: '2026-08-24' },
    'gpt-5.4': { inputPerMillionUsd: 2.5, outputPerMillionUsd: 15, checkedOn: '2026-08-24' },
    'gpt-5.4-mini': { inputPerMillionUsd: 0.75, outputPerMillionUsd: 4.5, checkedOn: '2026-08-24' },
    'gpt-5.4-nano': { inputPerMillionUsd: 0.2, outputPerMillionUsd: 1.25, checkedOn: '2026-08-24' },
    'gpt-5.2': { inputPerMillionUsd: 1.75, outputPerMillionUsd: 14, checkedOn: '2026-08-24' },
    'gpt-5.1': { inputPerMillionUsd: 1.25, outputPerMillionUsd: 10, checkedOn: '2026-08-24' },
    'gpt-5': { inputPerMillionUsd: 1.25, outputPerMillionUsd: 10, checkedOn: '2026-08-24' },
    'gpt-5-mini': { inputPerMillionUsd: 0.25, outputPerMillionUsd: 2, checkedOn: '2026-08-24' },
    'gpt-5-nano': { inputPerMillionUsd: 0.05, outputPerMillionUsd: 0.4, checkedOn: '2026-08-24' },
  },
} as const satisfies Partial<Record<PricedProvider, Readonly<Record<string, ModelPrice>>>>

/**
 * Units of each currency per dollar. Read from the European Central Bank's reference rates, via
 * api.frankfurter.dev, for 2026-08-21, which is the most recent working day the bank published.
 *
 * A committed rate is the same trade as a committed price and is made for the same reasons: a
 * fetch would put a third party in charge of when Caroline stops working. USD needs no conversion
 * and so carries no date, which is what keeps a dollar-denominated install from inheriting the
 * rate's staleness.
 */
export const exchangeRates = {
  USD: { perUsd: 1, checkedOn: null },
  GBP: { perUsd: 0.73228, checkedOn: '2026-08-21' },
  EUR: { perUsd: 0.85477, checkedOn: '2026-08-21' },
} as const satisfies Record<
  BudgetCurrency,
  { readonly perUsd: number; readonly checkedOn: string | null }
>

/**
 * Ollama's price, whatever the model. Zero, so neither the default nor an explicit figure can bill
 * for a provider running on the operator's own machine. Spec 03.
 */
const freeLocalModel: ModelPrice = {
  inputPerMillionUsd: 0,
  outputPerMillionUsd: 0,
  checkedOn: '2026-08-24',
}

/** The price for one model, or null where the table does not carry it. */
export function priceFor(provider: PricedProvider, model: string): ModelPrice | null {
  if (provider === 'ollama') return freeLocalModel

  const models: Readonly<Record<string, ModelPrice>> = modelPrices[provider]
  return models[model] ?? null
}

/** The amount in dollars, in the configured currency. */
export function convertFromUsd(usd: number, currency: BudgetCurrency): number {
  return usd * exchangeRates[currency].perUsd
}

/**
 * What one lot of tokens cost, in the configured currency. Input and output are priced at their
 * own rates, which is the accurate figure and the right one for a number a person reads. The
 * allowance the ceiling is enforced against is deliberately computed differently: see
 * `tokenAllowance`.
 */
export function estimateCost(
  price: ModelPrice,
  { inputTokens, outputTokens }: TokenCounts,
  currency: BudgetCurrency,
): number {
  const usd =
    (inputTokens * price.inputPerMillionUsd + outputTokens * price.outputPerMillionUsd) / 1_000_000

  return convertFromUsd(usd, currency)
}

/**
 * The date to show beside an estimate: the older of the price's own date and the exchange rate's,
 * because an estimate is only as fresh as its stalest input. In dollars there is no rate involved
 * and the answer is the price's date alone.
 */
export function priceCheckedOn(price: ModelPrice, currency: BudgetCurrency): string {
  const rateCheckedOn: string | null = exchangeRates[currency].checkedOn
  if (rateCheckedOn === null) return price.checkedOn

  // Both are `YYYY-MM-DD`, so they sort as strings.
  return price.checkedOn < rateCheckedOn ? price.checkedOn : rateCheckedOn
}

/**
 * How many tokens a ceiling buys: the amount, at the model's **output** rate. Output is the dearer
 * of the two rates, so the real spend for that many tokens is at most the ceiling whatever the mix
 * of input and output turns out to be. A ceiling is a bound rather than a target, and this is the
 * arithmetic that makes it one. Spec 03.
 *
 * A free model has no allowance to run out of, so it is unbounded rather than zero: dividing by a
 * zero rate would otherwise make Ollama the one provider a ceiling could stop.
 */
export function tokenAllowance(
  amount: number,
  currency: BudgetCurrency,
  price: ModelPrice,
): number {
  if (price.outputPerMillionUsd <= 0) return Number.POSITIVE_INFINITY

  // Divided by the per-million rate and then scaled up, rather than divided by a per-token rate.
  // The two are the same arithmetic and not the same floating point: dividing by 0.000005 puts
  // 5,999,999.999 where six million belongs, and the floor below would keep the error.
  const perMillion = convertFromUsd(price.outputPerMillionUsd, currency)
  return Math.floor((amount / perMillion) * 1_000_000)
}

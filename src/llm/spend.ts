/**
 * What the models have cost, priced against the committed table. Spec 03, criterion 15.
 *
 * Deliberately not the arithmetic the ceiling is enforced with. The ceiling is a bound and prices
 * everything at the dearest configured model's output rate so it can never be overshot; this is
 * reporting, so it prices each call at its own model's own two rates, which is the accurate figure
 * and the right one for a number a person reads. Both are stated in the spec.
 */
import type { Config } from '../config/schema.js'
import type { Database } from '../db/connection.js'
import { llmUsageBreakdown } from '../db/repositories/llm-calls.js'
import { periodStart } from '../domain/budget.js'
import { noUsage, type LlmPurpose, type LlmUsage } from '../domain/llm.js'
import {
  estimateCost,
  priceCheckedOn,
  priceFor,
  pricedProviders,
  type BudgetCurrency,
  type BudgetLimit,
  type BudgetPeriod,
  type PricedProvider,
} from '../domain/pricing.js'

/**
 * An amount in the configured currency, or null where the price table does not carry the model.
 * Null rather than zero: an unpriced call cost something, and a zero would say it did not.
 */
export type Estimate = number | null

export interface SpendByDay {
  readonly day: string
  readonly usage: LlmUsage
  readonly estimate: Estimate
}

export interface SpendByPurpose {
  readonly purpose: LlmPurpose
  readonly usage: LlmUsage
  readonly estimate: Estimate
}

export interface SpendByModel {
  readonly provider: PricedProvider
  readonly model: string
  readonly usage: LlmUsage
  readonly estimate: Estimate
}

export interface SpendByProvider {
  readonly provider: PricedProvider
  /** The ceiling as configured. `"unlimited"` is what the view reads as "no ceiling". */
  readonly limit: BudgetLimit
  /** Tokens recorded for this provider in the current period, which is what is enforced. */
  readonly tokens: number
  /** The token allowance, or null where there is none to be under. */
  readonly allowance: number | null
  readonly estimate: Estimate
}

export interface SpendReport {
  readonly currency: BudgetCurrency
  readonly period: BudgetPeriod
  /** The first instant of the period every figure below covers. */
  readonly since: number
  readonly byDay: readonly SpendByDay[]
  readonly byPurpose: readonly SpendByPurpose[]
  readonly byModel: readonly SpendByModel[]
  readonly providers: readonly SpendByProvider[]
  /**
   * The oldest date behind any figure here, or null when nothing in the window is priced. Shown
   * beside the estimate, so the figure says how old the prices it was built from are.
   */
  readonly checkedOn: string | null
}

function add(left: LlmUsage, right: LlmUsage): LlmUsage {
  return {
    calls: left.calls + right.calls,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
  }
}

/** Null plus a number is the number, because a group with one unpriced model is not unpriced. */
function addEstimate(left: Estimate, right: Estimate): Estimate {
  if (left === null) return right
  if (right === null) return left
  return left + right
}

export interface SpendReportOptions {
  readonly config: Config
  readonly database: Database
  readonly now?: () => number
}

/**
 * The spend for the current budget period, rolled up three ways. Every roll-up is built from the
 * same leaves, so the three cannot disagree, and each leaf is priced by its own model before it is
 * added to anything: a total taken across models could not be.
 */
export function spendReport({ config, database, now = Date.now }: SpendReportOptions): SpendReport {
  const { currency, period, limits, allowances } = config.llm.budget
  const timeZone = config.jobs.timezone
  const since = periodStart(now(), period, timeZone)

  const leaves = llmUsageBreakdown(database, { since, timeZone })

  const byDay = new Map<string, SpendByDay>()
  const byPurpose = new Map<LlmPurpose, SpendByPurpose>()
  const byModel = new Map<string, SpendByModel>()
  const byProvider = new Map<PricedProvider, { usage: LlmUsage; estimate: Estimate }>()
  let checkedOn: string | null = null

  for (const leaf of leaves) {
    const provider = leaf.provider
    const price = priceFor(provider, leaf.model)
    const estimate: Estimate = price === null ? null : estimateCost(price, leaf.usage, currency)

    if (price !== null) {
      const date = priceCheckedOn(price, currency)
      if (checkedOn === null || date < checkedOn) checkedOn = date
    }

    const day = byDay.get(leaf.day) ?? { day: leaf.day, usage: noUsage, estimate: null }
    byDay.set(leaf.day, {
      day: leaf.day,
      usage: add(day.usage, leaf.usage),
      estimate: addEstimate(day.estimate, estimate),
    })

    const purpose = byPurpose.get(leaf.purpose) ?? {
      purpose: leaf.purpose,
      usage: noUsage,
      estimate: null,
    }
    byPurpose.set(leaf.purpose, {
      purpose: leaf.purpose,
      usage: add(purpose.usage, leaf.usage),
      estimate: addEstimate(purpose.estimate, estimate),
    })

    const modelKey = `${provider}\u0000${leaf.model}`
    const model = byModel.get(modelKey) ?? {
      provider,
      model: leaf.model,
      usage: noUsage,
      estimate: null,
    }
    byModel.set(modelKey, {
      provider,
      model: leaf.model,
      usage: add(model.usage, leaf.usage),
      estimate: addEstimate(model.estimate, estimate),
    })

    const running = byProvider.get(provider) ?? { usage: noUsage, estimate: null }
    byProvider.set(provider, {
      usage: add(running.usage, leaf.usage),
      estimate: addEstimate(running.estimate, estimate),
    })
  }

  return {
    currency,
    period,
    since,
    // Most recent day first, which is how the usage view has always read.
    byDay: [...byDay.values()].toSorted((left, right) => right.day.localeCompare(left.day)),
    byPurpose: [...byPurpose.values()].toSorted((left, right) =>
      left.purpose.localeCompare(right.purpose),
    ),
    byModel: [...byModel.values()].toSorted(
      (left, right) =>
        left.provider.localeCompare(right.provider) || left.model.localeCompare(right.model),
    ),
    // Every provider, not only the ones that spent something: a ceiling somebody set and has not
    // reached is a fact worth showing, and "no ceiling" is legible where a blank is not.
    providers: pricedProviders.map((provider) => {
      const spent = byProvider.get(provider) ?? { usage: noUsage, estimate: null }

      return {
        provider,
        limit: limits[provider],
        // The same sum the gate enforces against, taken from the leaves it was rolled up from
        // rather than queried again, so the number shown and the number enforced cannot disagree.
        tokens: spent.usage.inputTokens + spent.usage.outputTokens,
        allowance: allowances[provider],
        estimate: spent.estimate,
      }
    }),
    checkedOn,
  }
}

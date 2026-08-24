/**
 * The spending ceiling, enforced. Spec 03, "The spending ceiling", criteria 11 to 14.
 *
 * Kept apart from `index.ts` so the decision has one home: the pure arithmetic is in
 * `src/domain/pricing.ts` and `src/domain/budget.ts`, the recorded tokens come from the
 * repository, and this is the only place the two meet.
 */
import type { Config } from '../config/schema.js'
import { withTransaction, type Database } from '../db/connection.js'
import { llmTokensForProvider } from '../db/repositories/llm-calls.js'
import { budgetReachedMessage, periodStart } from '../domain/budget.js'
import { UNLIMITED, type PricedProvider } from '../domain/pricing.js'
import type { CompletionChunk, CompletionRequest, CompletionResult, LlmProvider } from './types.js'
import { LlmError } from './types.js'

/**
 * A call refused because the ceiling has been reached, rather than because the provider failed.
 * Extends `LlmError` so that every caller that already handles a provider failure handles this
 * too, which is what keeps the degradation gap-free: a path nobody thought about here fails the
 * way a provider outage fails rather than throwing something nothing catches. The callers that
 * can say something better ask `refusalFor` first and never reach it.
 */
export class LlmBudgetError extends LlmError {
  override readonly name = 'LlmBudgetError'
}

export interface BudgetGate {
  /**
   * Null when a call to this provider is within its ceiling, otherwise the sentence saying it is
   * not, in words the person paying can act on.
   */
  refusalFor(provider: PricedProvider): string | null
}

export interface BudgetGateOptions {
  readonly config: Config
  /** Omitted, nothing is enforced: with no `llm_calls` table there is nothing to count. */
  readonly database?: Database | undefined
  readonly now?: (() => number) | undefined
}

/**
 * The gate every call passes. A provider with no ceiling short-circuits before touching the
 * database, which is what keeps this free for the install that has configured nothing.
 *
 * The count and the comparison happen inside one transaction. `node:sqlite` is synchronous and so
 * is a transaction over it, so no other call can record a row or take a reading between the two:
 * a classification run with three calls in flight cannot have all three pass a check that only one
 * of them should have passed. Spec 03, criterion 12.
 */
export function createBudgetGate({
  config,
  database,
  now = Date.now,
}: BudgetGateOptions): BudgetGate {
  const { currency, period, limits, allowances } = config.llm.budget

  return {
    refusalFor(provider) {
      const limit = limits[provider]
      const allowance = allowances[provider]
      if (limit === UNLIMITED || allowance === null || database === undefined) return null

      const since = periodStart(now(), period, config.jobs.timezone)
      const reached = withTransaction(
        database,
        () => llmTokensForProvider(database, { provider, since }) >= allowance,
      )

      return reached ? budgetReachedMessage(provider, limit, currency, period) : null
    },
  }
}

/**
 * The provider, refusing before anything reaches the network once its ceiling is reached. Wrapped
 * outside the validate-and-retry loop on purpose: a refusal is not an attempt, so it spends no
 * tokens and writes no `llm_calls` row.
 */
export function withBudget(provider: LlmProvider, refusal: () => string | null): LlmProvider {
  function check(): void {
    const reason = refusal()
    if (reason !== null) throw new LlmBudgetError(reason)
  }

  return {
    name: provider.name,
    isLocal: provider.isLocal,
    model: provider.model,
    supportsTools: provider.supportsTools,

    // `async` rather than returning the inner promise, so a refusal is a rejected promise like
    // every other failure a caller of `complete` handles, and not a synchronous throw from the
    // call expression itself.
    async complete(request: CompletionRequest): Promise<CompletionResult> {
      check()
      return provider.complete(request)
    },

    stream(request: CompletionRequest): AsyncIterable<CompletionChunk> {
      // Checked when iteration begins rather than when the iterable is built, so that a stream
      // held onto and consumed later is judged against the spend at the moment it actually runs.
      return {
        async *[Symbol.asyncIterator]() {
          check()
          yield* provider.stream(request)
        },
      }
    },
  }
}

/**
 * The spending ceiling, enforced. Spec 03, "The spending ceiling", criteria 11 to 14.
 *
 * Kept apart from `index.ts` so the decision has one home: the pure arithmetic is in
 * `src/domain/pricing.ts` and `src/domain/budget.ts`, the recorded tokens come from the
 * repository, and this is the only place the two meet.
 */
import type { Config } from '../config/schema.js'
import type { Database } from '../db/connection.js'
import { llmTokensForProvider } from '../db/repositories/llm-calls.js'
import { budgetReachedMessage, periodStart, reservationTokens } from '../domain/budget.js'
import { UNLIMITED, type PricedProvider } from '../domain/pricing.js'
import { SCHEMA_RETRIES } from './structured.js'
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

/**
 * A call's claim on the allowance while it is in flight. Released once the call's own `llm_calls`
 * rows exist, at which point the recorded tokens say what it really cost and the hold has nothing
 * left to stand in for.
 */
export interface BudgetHold {
  /** Idempotent, because more than one exit path may reach it for the same call. */
  release(): void
}

/** Either the reason a call cannot be made, or the hold it has taken on the allowance. */
export type BudgetReservation = { readonly refusal: string } | { readonly hold: BudgetHold }

/** A hold on a provider that enforces nothing. Nothing was taken, so nothing is given back. */
const noHold: BudgetHold = { release: () => {} }

export interface BudgetGate {
  /**
   * Null when a call to this provider is within its ceiling, otherwise the sentence saying it is
   * not, in words the person paying can act on. A question and not a claim on the allowance: it is
   * what a job asks before deciding to skip, and asking it changes nothing.
   */
  refusalFor(provider: PricedProvider): string | null
  /**
   * The same check, taken as a claim. Either the refusal, or a hold on `tokens` of the allowance
   * that the caller must release when the call it covers has been recorded. Spec 03, criterion 12.
   */
  reserve(provider: PricedProvider, tokens: number): BudgetReservation
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
 * A call is judged against the tokens recorded for the period **plus** the reservations held by
 * the calls currently in flight. Rows alone would not do: a row is written when a call returns, so
 * every call started before the first response landed would read the same total and pass. The
 * reading, the comparison and the reservation happen in one synchronous step, with no await
 * between them for another call to arrive in, which is what makes the claim indivisible. A
 * database transaction would not have added anything here: `node:sqlite` is synchronous, so the
 * single `select` was already indivisible, and the gap that mattered was the one between the
 * check and the row. Spec 03, criterion 12.
 *
 * The ledger is in memory rather than in the database because there is one process and one gate:
 * a reservation belongs to a call this process is waiting on, and a restart that loses them is
 * right to, because the calls they stood for are gone too.
 */
export function createBudgetGate({
  config,
  database,
  now = Date.now,
}: BudgetGateOptions): BudgetGate {
  const { currency, period, limits, allowances } = config.llm.budget

  /** Tokens held by the calls in flight, per provider. Zero for a provider with none. */
  const held = new Map<PricedProvider, number>()

  function enforced(provider: PricedProvider): boolean {
    return limits[provider] !== UNLIMITED && allowances[provider] !== null && database !== undefined
  }

  function refusalFor(provider: PricedProvider): string | null {
    const limit = limits[provider]
    const allowance = allowances[provider]
    if (limit === UNLIMITED || allowance === null || database === undefined) return null

    const since = periodStart(now(), period, config.jobs.timezone)
    const spent = llmTokensForProvider(database, { provider, since }) + (held.get(provider) ?? 0)

    return spent >= allowance ? budgetReachedMessage(provider, limit, currency, period) : null
  }

  return {
    refusalFor,

    reserve(provider, tokens) {
      const refusal = refusalFor(provider)
      if (refusal !== null) return { refusal }
      if (!enforced(provider)) return { hold: noHold }

      held.set(provider, (held.get(provider) ?? 0) + tokens)
      let released = false

      return {
        hold: {
          release() {
            if (released) return
            released = true
            held.set(provider, Math.max((held.get(provider) ?? 0) - tokens, 0))
          },
        },
      }
    },
  }
}

/**
 * What one `complete` is held against the allowance for: the prompt it carries and the output cap
 * the caller asked for, doubled where a schema brings the validate-and-retry rule with it, because
 * a retry is a second call this same reservation has to cover.
 */
export function reservationFor(request: CompletionRequest): number {
  const promptCharacters =
    request.system.length +
    request.messages.reduce((total, message) => total + message.content.length, 0)

  return reservationTokens({
    promptCharacters,
    maxOutputTokens: request.maxTokens,
    attempts: request.schema === undefined ? 1 : SCHEMA_RETRIES + 1,
  })
}

/**
 * The provider, refusing before anything reaches the network once its ceiling is reached, and
 * holding a reservation for whatever it does let through. Wrapped outside the validate-and-retry
 * loop on purpose: a refusal is not an attempt, so it spends no tokens and writes no `llm_calls`
 * row, and one reservation covers the retry as well as the first call.
 *
 * The hold is released in a `finally`, so a provider error, a timeout, a thrown exception and an
 * abandoned stream all give it back. A hold that leaked would take allowance out of circulation
 * until the next period, which is the one way this could be worse than not enforcing at all.
 */
export function withBudget(
  provider: LlmProvider,
  reserve: (tokens: number) => BudgetReservation,
): LlmProvider {
  function begin(request: CompletionRequest): BudgetHold {
    const outcome = reserve(reservationFor(request))
    if ('refusal' in outcome) throw new LlmBudgetError(outcome.refusal)
    return outcome.hold
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
      const hold = begin(request)

      try {
        // Awaited rather than returned, so the hold outlives the call it covers: the row is
        // written by the recorder inside this await, and returning the promise would release
        // before it.
        return await provider.complete(request)
      } finally {
        hold.release()
      }
    },

    stream(request: CompletionRequest): AsyncIterable<CompletionChunk> {
      // Reserved when iteration begins rather than when the iterable is built, so that a stream
      // held onto and consumed later is judged against the spend at the moment it actually runs.
      return {
        async *[Symbol.asyncIterator]() {
          const hold = begin(request)

          try {
            yield* provider.stream(request)
          } finally {
            hold.release()
          }
        },
      }
    },
  }
}

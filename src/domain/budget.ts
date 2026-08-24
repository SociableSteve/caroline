/**
 * The spending ceiling as arithmetic and words, with no IO in it. Spec 03, "The spending ceiling".
 * The table the amounts are priced against is `pricing.ts`; what reads the recorded tokens and
 * decides is `src/llm/budget.ts`.
 */
import type { BudgetCurrency, BudgetPeriod, PricedProvider } from './pricing.js'
import { instantAt, localDateAt } from './time.js'

/**
 * The first instant of the period the given moment falls in, in the install's own zone. Resolved
 * through `Intl` rather than by a fixed offset, for the reason a usage day is: one offset applied
 * to the whole table is only correct until a daylight-saving change.
 *
 * The fallback counts from the epoch rather than from now, which cannot happen (a calendar day
 * always has a first minute, and `instantAt` scans forward to find it) but has a right answer
 * anyway: for a guard about money the conservative direction is to count more spend rather than
 * less.
 */
export function periodStart(now: number, period: BudgetPeriod, timeZone: string): number {
  const today = localDateAt(now, timeZone)
  const first = period === 'day' ? today : { ...today, day: 1 }

  return instantAt(first, 0, timeZone) ?? 0
}

/**
 * What a caller is told when a provider's ceiling has been reached. One sentence naming every
 * setting involved, in the shape the config-load refusals already use, so that whoever reads it in
 * the run history, in the chat rail or in an MCP tool result can act on it without going looking.
 */
export function budgetReachedMessage(
  provider: PricedProvider,
  amount: number,
  currency: BudgetCurrency,
  period: BudgetPeriod,
): string {
  return (
    `The spending ceiling for "${provider}" has been reached: llm.budget sets it to ` +
    `${amount} ${currency} per ${period}, and the tokens recorded so far this ${period}, with ` +
    `the calls in flight, are worth at least that. Raise llm.budget.${provider}, set it to ` +
    `"unlimited", or wait for the next ${period}.`
  )
}

/**
 * How many characters of prompt a reservation counts as one token. English against these models
 * runs closer to four, so three deliberately overstates: a reservation is a hold taken while a
 * call is in flight and given back the moment its row is written, so overstating it can only
 * refuse a call close to the ceiling that would in fact have fitted. For a guard about money that
 * is the safe direction. Spec 03, "What is counted, and against what".
 */
const RESERVATION_CHARACTERS_PER_TOKEN = 3

export interface ReservationInput {
  /**
   * Every character of the request that will be sent: the system prompt, the messages with their
   * tool calls and tool results, the tool definitions and the output schema. Whoever computes it
   * is responsible for leaving nothing out, because what is left out is allowance the hold does
   * not cover. `reservationFor` in `src/llm/budget.ts` is the one caller.
   */
  readonly promptCharacters: number
  /** The output cap the caller asked for, which is the most output one attempt can produce. */
  readonly maxOutputTokens: number
  /** How many provider calls the request can turn into, retries included. At least one. */
  readonly attempts: number
}

/**
 * What one call is held against the allowance for, at worst. Not an accurate token count and not
 * meant to be one: the accurate figure is what the provider reports, and it replaces this the
 * moment the call is recorded. Spec 03, criterion 12.
 */
export function reservationTokens({
  promptCharacters,
  maxOutputTokens,
  attempts,
}: ReservationInput): number {
  const perAttempt =
    Math.ceil(promptCharacters / RESERVATION_CHARACTERS_PER_TOKEN) + maxOutputTokens

  return perAttempt * Math.max(attempts, 1)
}

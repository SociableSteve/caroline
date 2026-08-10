/**
 * The bit of talking to a Google API that is the same whichever API it is: a bearer token per
 * request, a deadline per request and another for the pass, and reading a refusal correctly.
 *
 * That last one is the reason this is shared rather than written twice. A 403 covers both a
 * quota the scheduler should back off from and a scope it will never be granted, and the two
 * want opposite answers: waiting fixes the first and only the user can fix the second. Getting
 * that right once for Gmail and then differently for Calendar is how a permanent failure ends
 * up being retried every quarter of an hour for the life of the process.
 *
 * Nothing here knows about threads, events, tasks or the database.
 */

/** How long one request may take before it is given up on. */
export const REQUEST_TIMEOUT_MS = 20_000

/**
 * How long one pass may take in total, however many requests it makes. A per-request deadline
 * is not a bound on a pass that fetches an item at a time: a run held open indefinitely is a
 * run the overlap guard answers "already running" to for the rest of the process's life.
 */
export const PASS_TIMEOUT_MS = 120_000

/**
 * Why Google refused, in its own words. The `reason` in the body is what tells a quota apart
 * from a missing scope.
 */
interface ErrorResponse {
  readonly error?: {
    readonly message?: unknown
    readonly errors?: readonly { readonly reason?: unknown }[]
  }
}

const quotaReasons = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'dailyLimitExceeded',
  'quotaExceeded',
  'backendError',
])

export interface GoogleClientOptions {
  /** The product's name as it should appear in a message a person reads. */
  readonly product: string
  readonly baseUrl: string
  /** Asked afresh per request, so a token that expires mid-pass is refreshed rather than reused. */
  readonly accessToken: () => Promise<string>
  /**
   * How the caller wants a failure raised. Each connector keeps its own error type, so a
   * caller can tell a Gmail failure from a calendar one without reading the message.
   */
  readonly fail: (message: string) => Error
  readonly fetch?: typeof globalThis.fetch
  readonly timeoutMs?: number
  readonly passTimeoutMs?: number
}

export interface GoogleClient {
  /**
   * Opens a budget for one pass and hands it back to be passed to every call the pass makes.
   * The caller owns it because the caller is what knows where a pass begins and ends: a budget
   * created per call would bound each request and not the pass, which is the thing the overlap
   * guard is waiting on.
   */
  beginPass(): AbortSignal
  get(path: string, pass?: AbortSignal): Promise<unknown>
}

export function createGoogleClient({
  product,
  baseUrl,
  accessToken,
  fail,
  fetch = globalThis.fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
  passTimeoutMs = PASS_TIMEOUT_MS,
}: GoogleClientOptions): GoogleClient {
  async function refusal(response: Response): Promise<string> {
    const body = (await response.json().catch(() => null)) as ErrorResponse | null
    const reasons = (body?.error?.errors ?? [])
      .map((entry) => (typeof entry.reason === 'string' ? entry.reason : null))
      .filter((reason): reason is string => reason !== null)

    // Rate limiting is handled by respecting Google's own answer rather than by sleeping a
    // fixed amount: the run fails saying so, and the scheduler's backoff decides when to try
    // again (spec 02).
    if (response.status === 429 || reasons.some((reason) => quotaReasons.has(reason))) {
      return `${product} rate limit reached (${reasons.join(', ') || response.status}). The next scheduled run will try again.`
    }

    // A permission failure is permanent, and backing off from it would retry it forever. The
    // run history should say what would actually fix it.
    const detail =
      typeof body?.error?.message === 'string' ? body.error.message : response.statusText

    return `${product} refused the request with ${response.status}${
      reasons.length === 0 ? '' : ` (${reasons.join(', ')})`
    }: ${detail}. Caroline may not have the scope it needs, so reconnect the Google account from Settings.`
  }

  function budget(): AbortSignal {
    return AbortSignal.timeout(passTimeoutMs)
  }

  return {
    beginPass: budget,

    async get(path, pass = budget()) {
      const token = await accessToken()

      let response: Response
      try {
        response = await fetch(`${baseUrl}${path}`, {
          headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
          // Whichever runs out first: this request, or the pass it belongs to.
          signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), pass]),
        })
      } catch (error) {
        if (error instanceof Error && error.name === 'TimeoutError') {
          throw fail(
            pass.aborted
              ? `${product} did not finish answering within ${passTimeoutMs}ms`
              : `${product} did not answer within ${timeoutMs}ms`,
          )
        }
        throw error
      }

      if (response.status === 429 || response.status === 403) {
        throw fail(await refusal(response))
      }

      if (response.status === 401) {
        throw fail(
          `${product} rejected the access token. Reconnect the Google account from Settings.`,
        )
      }

      if (!response.ok) {
        throw fail(`${product} answered ${response.status} ${response.statusText}`)
      }

      return response.json()
    },
  }
}

/**
 * The Gmail side of the connector: the two calls it makes, the shape of what comes back, and
 * the HTTP client that makes them. Nothing here knows about tasks, sources or the database,
 * which is what lets the connector be driven by recorded fixtures with no network anywhere in
 * the suite. Spec 02, criterion 8.
 *
 * Read-only, thread level, one account. No labelling, no archiving, nothing that writes.
 */
export const GMAIL_BASE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me'

/** A thread as Gmail returns it, reduced to the fields Caroline reads. */
export interface GmailThread {
  readonly id: string
  readonly messages?: readonly GmailMessage[]
}

export interface GmailMessage {
  readonly id?: string
  readonly labelIds?: readonly string[]
  /** Gmail's own one-line preview. The fallback when no text part can be decoded. */
  readonly snippet?: string
  /** Epoch milliseconds, as a string, which is how Gmail sends it. */
  readonly internalDate?: string
  readonly payload?: GmailPart
}

export interface GmailPart {
  readonly mimeType?: string
  readonly filename?: string
  readonly headers?: readonly { readonly name?: string; readonly value?: string }[]
  readonly body?: { readonly data?: string; readonly size?: number }
  readonly parts?: readonly GmailPart[]
}

/** Which shape of thread to ask for. `metadata` cannot carry a body; `full` can. */
export type ThreadFormat = 'metadata' | 'full'

export interface GmailApi {
  /** Every thread the query matches, newest first, as Gmail orders them. */
  listThreadIds(query: string): Promise<string[]>
  getThread(id: string, format: ThreadFormat): Promise<GmailThread>
}

/** A Gmail call that failed. Its message is what ends up in the run history. */
export class GmailApiError extends Error {
  override readonly name = 'GmailApiError'
}

/** How many thread ids one list request asks for. Gmail's own maximum is 500. */
export const LIST_PAGE = 100

/**
 * A runaway guard rather than a policy: the listing is paged until Gmail says there is no more.
 * Ten pages of a hundred is an inbox nobody is triaging, and failing loudly beats returning a
 * partial result set, because a thread missing from the set reads as one handled in Gmail and
 * would retire its task.
 */
export const LIST_MAX_PAGES = 10

/** How long one Gmail request may take. */
export const REQUEST_TIMEOUT_MS = 20_000

/**
 * How long one pass may take in total, however many requests it makes. A per-request deadline
 * is not a bound on a pass that fetches a thread at a time: a run held open indefinitely is a
 * run the overlap guard answers "already running" to for the rest of the process's life.
 */
export const PASS_TIMEOUT_MS = 120_000

export interface GmailApiOptions {
  /** Asked afresh per request, so a token that expires mid-pass is refreshed rather than reused. */
  readonly accessToken: () => Promise<string>
  readonly baseUrl?: string
  readonly fetch?: typeof globalThis.fetch
  readonly timeoutMs?: number
  readonly passTimeoutMs?: number
}

interface ListResponse {
  readonly threads?: readonly { readonly id?: unknown }[]
  readonly nextPageToken?: unknown
}

/**
 * Rate limiting is handled by respecting Google's own answer rather than by sleeping a fixed
 * amount: the run fails saying so, and the scheduler's backoff decides when to try again.
 * Spec 02.
 */
function rateLimited(response: Response): boolean {
  return response.status === 429 || response.status === 403
}

export function createGmailApi({
  accessToken,
  baseUrl = GMAIL_BASE_URL,
  fetch = globalThis.fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
  passTimeoutMs = PASS_TIMEOUT_MS,
}: GmailApiOptions): GmailApi {
  /** A budget for one pass, shared by every request it makes. */
  function budget(): AbortSignal {
    return AbortSignal.timeout(passTimeoutMs)
  }

  async function get(path: string, pass: AbortSignal): Promise<unknown> {
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
        throw new GmailApiError(
          pass.aborted
            ? `Gmail did not finish answering within ${passTimeoutMs}ms`
            : `Gmail did not answer within ${timeoutMs}ms`,
        )
      }
      throw error
    }

    if (rateLimited(response)) {
      throw new GmailApiError(
        `Gmail refused the request with ${response.status}, which is usually its rate limit or a scope Caroline has not been granted`,
      )
    }

    if (response.status === 401) {
      throw new GmailApiError(
        'Gmail rejected the access token. Reconnect the Google account from Settings.',
      )
    }

    if (!response.ok) {
      throw new GmailApiError(`Gmail answered ${response.status} ${response.statusText}`)
    }

    return response.json()
  }

  return {
    async listThreadIds(query) {
      const ids: string[] = []
      const pass = budget()
      let pageToken: string | null = null

      for (let page = 0; page < LIST_MAX_PAGES; page += 1) {
        const search = new URLSearchParams({ q: query, maxResults: String(LIST_PAGE) })
        if (pageToken !== null) search.set('pageToken', pageToken)

        const body = (await get(`/threads?${search.toString()}`, pass)) as ListResponse

        for (const thread of body.threads ?? []) {
          if (typeof thread.id === 'string') ids.push(thread.id)
        }

        const next = body.nextPageToken
        if (typeof next !== 'string' || next === '') return ids

        pageToken = next

        // Still more pages after the guard. Returning what has been read so far would read as
        // the whole result set, and every thread missing from it would look handled in Gmail.
        if (page === LIST_MAX_PAGES - 1) {
          throw new GmailApiError(
            `The Gmail query still had pages after ${LIST_MAX_PAGES} of ${LIST_PAGE}. Narrow integrations.google.gmailQuery.`,
          )
        }
      }

      return ids
    },

    async getThread(id, format) {
      const body = (await get(
        `/threads/${encodeURIComponent(id)}?format=${format}`,
        budget(),
      )) as GmailThread

      if (typeof body?.id !== 'string') {
        throw new GmailApiError(`Gmail returned no thread for ${id}`)
      }

      return body
    },
  }
}

/**
 * Reading the recorded Gmail payloads, and a fake `GmailApi` over them. Nothing in the suite
 * reaches the network: the connector is driven entirely by what is in `test/fixtures/gmail`.
 * Spec 02, criterion 8.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { GmailApi, GmailThread, ThreadFormat } from '../../src/connectors/gmail/api.js'

export function gmailFixture(name: string): GmailThread {
  const path = fileURLToPath(new URL(`../fixtures/gmail/${name}.json`, import.meta.url))
  return JSON.parse(readFileSync(path, 'utf8')) as GmailThread
}

/** Every recorded thread, keyed by the id a listing returns. A listing picks among them. */
export function recordedThreads(): Map<string, GmailThread> {
  return new Map(
    [
      'thread-hub-numbers',
      'thread-invoice',
      'thread-github-review-request',
      'thread-github-issue',
    ].map((name) => {
      const thread = gmailFixture(name)
      return [thread.id, thread]
    }),
  )
}

export interface FakeGmailApi extends GmailApi {
  /** The queries each listing was asked for, so a test can assert the configured one is used. */
  readonly queries: string[]
  /** Which format each thread was fetched in, which is what the content policy decides. */
  readonly formats: ThreadFormat[]
  /** The pass budget each call was given, so a test can assert one pass shares one budget. */
  readonly passes: Array<AbortSignal | undefined>
  /** How many budgets were opened. One per pass, however many calls the pass makes. */
  readonly passesBegun: () => number
}

export interface FakeGmailApiOptions {
  /** The ids each successive listing returns. The last entry repeats after that. */
  readonly listings: ReadonlyArray<readonly string[]>
  readonly threads?: Map<string, GmailThread>
  /** Thrown by the listing, for the failure-isolation cases. */
  readonly failWith?: Error
}

export function fakeGmailApi({
  listings,
  threads = recordedThreads(),
  failWith,
}: FakeGmailApiOptions): FakeGmailApi {
  const queries: string[] = []
  const formats: ThreadFormat[] = []
  const passes: Array<AbortSignal | undefined> = []
  let listed = 0
  let begun = 0

  return {
    queries,
    formats,
    passes,
    passesBegun: () => begun,

    beginPass() {
      begun += 1
      // A real signal, so a test that asserts one budget per pass is comparing the real thing.
      return AbortSignal.timeout(60_000)
    },

    async listThreadIds(query, pass) {
      if (failWith !== undefined) throw failWith

      queries.push(query)
      passes.push(pass)
      const ids = listings[Math.min(listed, listings.length - 1)] ?? []
      listed += 1
      return [...ids]
    },

    async getThread(id, format, pass) {
      formats.push(format)
      passes.push(pass)
      const thread = threads.get(id)
      if (thread === undefined) throw new Error(`No recorded thread ${id}`)
      return thread
    },
  }
}

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

/** The two recorded threads, keyed by the id the listing returns. */
export function recordedThreads(): Map<string, GmailThread> {
  return new Map(
    ['thread-hub-numbers', 'thread-invoice'].map((name) => {
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
  let listed = 0

  return {
    queries,
    formats,

    async listThreadIds(query) {
      if (failWith !== undefined) throw failWith

      queries.push(query)
      const ids = listings[Math.min(listed, listings.length - 1)] ?? []
      listed += 1
      return [...ids]
    },

    async getThread(id, format) {
      formats.push(format)
      const thread = threads.get(id)
      if (thread === undefined) throw new Error(`No recorded thread ${id}`)
      return thread
    },
  }
}

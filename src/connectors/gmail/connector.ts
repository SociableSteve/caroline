/**
 * The Gmail connector: one account, read-only, thread level, one task per thread. Spec 02.
 *
 * There is no incremental pass and the `since` cursor is deliberately ignored. Resolution here
 * is a thread *leaving* the query's result set, which is how triaging in Gmail reaches Caroline,
 * and only the whole result set says what has left it. An incremental query would answer with
 * what has arrived, which is the other question.
 */
import type { Connector, SourceItem } from '../types.js'
import type { GmailApi, ThreadFormat } from './api.js'
import { toSourceItem } from './map.js'

/** What the engine knows about a thread it has already seen. */
export interface KnownThread {
  readonly externalId: string
  /**
   * Carried forward on a resolution item rather than refetched. The upsert writes what the item
   * says, so an item built without them would blank the row's title and link on the way out.
   */
  readonly title: string | null
  readonly url: string | null
  readonly metadata: unknown
}

export interface GmailConnectorOptions {
  readonly api: GmailApi
  /** False with no credentials or no consent, which has the engine skip rather than fail. */
  readonly isConfigured: () => boolean
  /** The Gmail search that defines what is in scope. Spec 02. */
  readonly query: string
  /** Whether a body needs fetching at all, which is what the content policies decide. Spec 09. */
  readonly needsBody: () => boolean
  /** The unresolved Gmail sources, read at the moment the pass runs. */
  readonly known: () => readonly KnownThread[]
}

export function createGmailConnector({
  api,
  isConfigured,
  query,
  needsBody,
  known,
}: GmailConnectorOptions): Connector {
  return {
    provider: 'gmail',
    isConfigured,

    async *fetch(): AsyncIterable<SourceItem> {
      // `metadata` when no policy asks for a body: the smallest request that answers the
      // question is the one to make, and a body nobody may store or send is one nobody should
      // ask Google for. Spec 09.
      const format: ThreadFormat = needsBody() ? 'full' : 'metadata'

      const ids = await api.listThreadIds(query)
      const present = new Set(ids)

      for (const id of ids) {
        yield toSourceItem(await api.getThread(id, format))
      }

      // A thread Caroline is following that the query no longer matches has been archived or
      // otherwise handled in Gmail. Completion is proposed so that triaging in Gmail is not
      // lost work; whether the task is actually completed is the engine's rule, not this one's.
      for (const thread of known()) {
        if (present.has(thread.externalId)) continue

        yield {
          externalId: thread.externalId,
          url: thread.url ?? '',
          title: thread.title ?? '',
          metadata: (thread.metadata ?? {}) as Record<string, unknown>,
          resolved: true,
          // Nothing new happened upstream: the item's own moment is the last one known, and the
          // engine stamps the resolution with the run's clock rather than this.
          occurredAt: 0,
        }
      }
    },
  }
}

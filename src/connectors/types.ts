/**
 * The one interface every connector implements. The engine owns everything else: upsert by
 * `(provider, external_id)`, content hashing, task creation, error handling and run
 * recording. A connector fetches and describes; it never writes. Spec 02.
 */
import type { SourceProvider } from '../domain/source.js'
import type { TaskStatus } from '../domain/task.js'

/**
 * What the connector wants the item's task to look like. Absent means items of this kind do
 * not become tasks at all, which is how a calendar event stays an event. Spec 02, criterion 7.
 */
export interface TaskIntent {
  /** Where the connector's lifecycle says this belongs. Always inside its tracked set. */
  readonly status: TaskStatus
  readonly waitingOn?: string | null
  /**
   * Seeded on creation only, never overwritten: the estimate is editable, and a sync that
   * reimposed its own guess every fifteen minutes would not leave it editable for long.
   */
  readonly estimateMinutes?: number | null
}

export interface SourceItem {
  readonly externalId: string
  readonly url: string
  readonly title: string
  readonly metadata: Record<string, unknown>
  /** Subject to the storage content policy, spec 09. Absent for items that have no body. */
  readonly content?: string
  /** The upstream item is closed, merged or otherwise handled. */
  readonly resolved?: boolean
  readonly occurredAt: number
  readonly task?: TaskIntent
  /** The connector's state machine position, stored on the source and handed back next run. */
  readonly lifecycleState?: string
  readonly actedAt?: number | null
  readonly actedAtMarker?: string | null
}

export interface Connector {
  readonly provider: SourceProvider
  /** False with no credentials, which the engine treats as a skip rather than a failure. */
  isConfigured(): boolean
  /**
   * `since` is the cursor from the last successful run, or null on a first run. A provider
   * with no incremental fetch ignores it and scans.
   */
  fetch(since: number | null): AsyncIterable<SourceItem>
}

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

/**
 * The item another connector owns, that this one is a second telling of. A GitHub notification
 * email names a pull request; the pull request is the work, and the email is a route to it.
 * Spec 02, notification emails as a backup source.
 */
export interface BackupReference {
  readonly provider: SourceProvider
  readonly externalId: string
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
  /**
   * Set when this item is a second telling of an item another connector owns. The engine decides it
   * by the backup-source rule rather than the ordinary upsert rules: it is not work of its own.
   */
  readonly backupFor?: BackupReference
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

/**
 * A connector that can also be asked for one named item, whatever its discovery query would say.
 * That is what lets another connector act as a backup source for it: an email about a pull request
 * the search missed is only worth anything if that one pull request can be fetched on its own.
 * Spec 02.
 */
export interface AddressableConnector extends Connector {
  /**
   * One item by its external id. Null when the id names nothing this connector can fetch, which
   * the engine reads as the backup source being unable to do its job rather than as a failure.
   */
  item(externalId: string): Promise<SourceItem | null>
}

export function isAddressable(connector: Connector): connector is AddressableConnector {
  return typeof (connector as Partial<AddressableConnector>).item === 'function'
}

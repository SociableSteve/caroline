/**
 * One row per externally ingested item. A source may exist without a task (a calendar
 * event never becomes one) and a task may exist without a source (manual capture).
 * Spec 01.
 */

export const sourceProviders = ['github', 'gmail', 'gcal'] as const
export type SourceProvider = (typeof sourceProviders)[number]

export interface Source {
  readonly id: string
  readonly provider: SourceProvider
  /** Provider-stable identifier. Unique with `provider`, and the sync engine's dedupe key. */
  readonly externalId: string
  readonly url: string | null
  readonly title: string | null
  /** Provider-specific. The shape is owned by the connector, not by this layer. */
  readonly metadata: unknown
  /** Nullable, and governed by the storage content policy in spec 09. */
  readonly content: string | null
  /** Detects upstream change without diffing bodies. */
  readonly contentHash: string | null
  readonly taskId: string | null
  readonly firstSeenAt: number
  readonly lastSeenAt: number
  /** Set when the upstream item closes. Sync never deletes; it resolves. */
  readonly resolvedAt: number | null
  /** Connector-owned state machine position. Spec 02. */
  readonly lifecycleState: string | null
  /** When the user last discharged their part. For a pull request, reviewed it. */
  readonly actedAt: number | null
  /** Upstream position at `actedAt`, so later change is distinguishable from no change. */
  readonly actedAtMarker: string | null
}

export interface ActedRecord {
  readonly at: number
  readonly marker: string
}

export function markActed(source: Source, acted: ActedRecord): Source {
  return { ...source, actedAt: acted.at, actedAtMarker: acted.marker }
}

export function markResolved(source: Source, at: number): Source {
  return { ...source, resolvedAt: at }
}

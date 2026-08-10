/**
 * One row per externally ingested item. A source may exist without a task (a calendar
 * event never becomes one) and a task may exist without a source (manual capture).
 * Spec 01.
 */

import type { ContentLevel } from './content.js'

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
  /**
   * The policy level `content` was written under. The text cannot say which it is: three
   * hundred characters may be a truncated snippet or a whole short body, and lowering the
   * policy later has to tell them apart. Spec 09, criterion 4.
   */
  readonly contentLevel: ContentLevel
  /**
   * When the body was written. What retention is measured from, rather than `lastSeenAt`: a
   * thread still in the inbox is seen every fifteen minutes, so measuring from that would mean
   * no body was ever old enough to purge. Spec 09, criterion 5.
   */
  readonly contentStoredAt: number | null
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
  /**
   * When an upstream content change last put the linked task back in the classification
   * queue. Only ever set while that task is in `inbox`. Spec 02, criterion 2.
   */
  readonly requeuedAt: number | null
  /**
   * When sync proposed completing the linked task. A proposal rather than the act: sync
   * never completes an open item, and never silently completes one the user has since
   * decided on for themselves. Spec 02, criterion 4.
   */
  readonly completionProposedAt: number | null
}

export interface ActedRecord {
  readonly at: number
  readonly marker: string
}

export function markActed(source: Source, acted: ActedRecord): Source {
  return { ...source, actedAt: acted.at, actedAtMarker: acted.marker }
}

/**
 * The upstream item closed or vanished. `resolvedAt` keeps the first moment it was seen to
 * have gone: a second sync over an already-resolved item is not a second resolution.
 */
export function markResolved(source: Source, at: number): Source {
  return { ...source, resolvedAt: source.resolvedAt ?? at }
}

/** Sync would like the linked task completed. Whether it may is the caller's decision. */
export function proposeCompletion(source: Source, at: number): Source {
  return { ...source, completionProposedAt: source.completionProposedAt ?? at }
}

export function markRequeued(source: Source, at: number): Source {
  return { ...source, requeuedAt: at }
}

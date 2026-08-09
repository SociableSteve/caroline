/**
 * Content hashing. The engine compares hashes rather than bodies to decide whether an item
 * changed upstream, which is what keeps a sync that sees the same thing every fifteen
 * minutes from touching anything. Spec 02.
 */
import { createHash } from 'node:crypto'
import type { SourceItem } from './types.js'

/**
 * `JSON.stringify` preserves insertion order, so two objects with the same fields in a
 * different order would hash differently and a connector that built its metadata in a new
 * order would look like an upstream change to every item at once. Keys are sorted at every
 * depth to make the encoding a function of the value alone. Arrays keep their order, which
 * is part of their value.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`

  const entries = Object.entries(value as Record<string, unknown>)
    // `undefined` is absent from JSON, so a key holding one is dropped rather than encoded:
    // otherwise `{ a: undefined }` and `{}` would hash differently while encoding the same.
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))

  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`
}

/**
 * What counts as the item's content, for the purpose of noticing it changed. Everything the
 * connector reports except `occurredAt`: a provider that touches its updated-at stamp
 * without changing anything would otherwise requeue the item for classification on a
 * difference nobody can see.
 */
export function contentHash(item: SourceItem): string {
  return createHash('sha256')
    .update(
      stableStringify({
        title: item.title,
        url: item.url,
        content: item.content ?? null,
        metadata: item.metadata,
      }),
    )
    .digest('hex')
}

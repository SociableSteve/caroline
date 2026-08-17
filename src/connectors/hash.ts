/**
 * Content hashing. The engine compares hashes rather than bodies to decide whether an item
 * changed upstream, which is what keeps a sync that sees the same thing every fifteen
 * minutes from touching anything. Spec 02.
 */
import { createHash } from 'node:crypto'
import { stableStringify } from '../domain/stable-stringify.js'
import type { SourceItem } from './types.js'

export { stableStringify }

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

import { describe, expect, it } from 'vitest'
import { contentHash, stableStringify } from '../../src/connectors/hash.js'
import type { SourceItem } from '../../src/connectors/types.js'

const item: SourceItem = {
  externalId: 'example-org/example-service#42',
  url: 'https://github.com/example-org/example-service/pull/42',
  title: 'Add a retry to the fetch helper',
  metadata: { repository: 'example-org/example-service', number: 42, draft: false },
  occurredAt: Date.UTC(2026, 0, 5, 9, 15),
}

describe('stable stringify', () => {
  it('encodes the same object the same way whatever order its keys were built in', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }))
  })

  it('sorts at every depth, not just the top', () => {
    expect(stableStringify({ outer: { z: 1, a: 2 } })).toBe('{"outer":{"a":2,"z":1}}')
  })

  it('keeps array order, which is part of the value rather than an accident of building it', () => {
    expect(stableStringify([2, 1])).not.toBe(stableStringify([1, 2]))
  })

  it('drops a key holding undefined, which JSON has no way to encode anyway', () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }))
  })

  it('handles null, which is an object as far as typeof is concerned', () => {
    expect(stableStringify({ a: null })).toBe('{"a":null}')
  })
})

describe('the content hash', () => {
  it('is stable across runs over an unchanged item', () => {
    expect(contentHash(item)).toBe(contentHash({ ...item }))
  })

  it('does not move when only the provider touched its updated-at stamp', () => {
    expect(contentHash({ ...item, occurredAt: item.occurredAt + 60_000 })).toBe(contentHash(item))
  })

  it.each([
    ['title', { title: 'Add two retries to the fetch helper' }],
    ['url', { url: 'https://github.com/example-org/example-service/pull/43' }],
    ['content', { content: 'a body that was not there before' }],
    ['metadata', { metadata: { ...item.metadata, draft: true } }],
  ])('moves when the %s changes', (_field, change) => {
    expect(contentHash({ ...item, ...change })).not.toBe(contentHash(item))
  })

  /**
   * The lifecycle is where the item sits, not what it says. Hashing it would make every
   * transition look like an upstream content change, and a content change is what returns an
   * inbox task to the classification queue. Spec 02, criterion 2.
   */
  it('does not move when only the connector’s lifecycle position changed', () => {
    expect(
      contentHash({
        ...item,
        lifecycleState: 'reviewed',
        actedAt: item.occurredAt,
        actedAtMarker: 'sha-one',
      }),
    ).toBe(contentHash(item))
  })

  it('does not move when only the item was marked resolved', () => {
    expect(contentHash({ ...item, resolved: true })).toBe(contentHash(item))
  })

  it('does not move when the metadata is the same facts in another order', () => {
    expect(
      contentHash({
        ...item,
        metadata: { draft: false, number: 42, repository: 'example-org/example-service' },
      }),
    ).toBe(contentHash(item))
  })
})

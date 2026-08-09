import { beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '../../../src/db/connection.js'
import {
  countSources,
  getSource,
  getSourceByExternalId,
  listSourcesForTask,
  markSourceActed,
  markSourceResolved,
  upsertSource,
  type UpsertSourceInput,
} from '../../../src/db/repositories/sources.js'
import { createTask, deleteTask } from '../../../src/db/repositories/tasks.js'
import { migratedDatabase } from '../../helpers/temp-database.js'

const firstSeenAt = Date.UTC(2026, 0, 1)
const later = firstSeenAt + 60_000

let database: Database

function pullRequest(overrides: Partial<UpsertSourceInput> = {}): UpsertSourceInput {
  return {
    provider: 'github',
    externalId: 'octo/widgets#42',
    url: 'https://github.com/octo/widgets/pull/42',
    title: 'Cache the widget index',
    metadata: { repository: 'octo/widgets', number: 42 },
    contentHash: 'hash-of-the-original',
    ...overrides,
  }
}

beforeEach(() => {
  database = migratedDatabase()
})

describe('upsertSource', () => {
  it('creates a source that was not there', () => {
    const source = upsertSource(database, pullRequest(), firstSeenAt)

    expect(source.provider).toBe('github')
    expect(source.externalId).toBe('octo/widgets#42')
    expect(source.firstSeenAt).toBe(firstSeenAt)
    expect(source.lastSeenAt).toBe(firstSeenAt)
  })

  // Criterion 3. This is the dedupe key for the whole sync engine.
  it('updates the existing row on a second insert with the same provider and external id', () => {
    upsertSource(database, pullRequest(), firstSeenAt)

    upsertSource(database, pullRequest({ title: 'Cache the widget index, take two' }), later)

    expect(countSources(database)).toBe(1)
    expect(getSourceByExternalId(database, 'github', 'octo/widgets#42')?.title).toBe(
      'Cache the widget index, take two',
    )
  })

  it('keeps the original id across an update, so anything referencing it still resolves', () => {
    const created = upsertSource(database, pullRequest(), firstSeenAt)

    const updated = upsertSource(database, pullRequest({ title: 'Renamed' }), later)

    expect(updated.id).toBe(created.id)
  })

  it('keeps first_seen_at from the first sighting and moves last_seen_at on', () => {
    upsertSource(database, pullRequest(), firstSeenAt)

    const updated = upsertSource(database, pullRequest(), later)

    expect(updated.firstSeenAt).toBe(firstSeenAt)
    expect(updated.lastSeenAt).toBe(later)
  })

  it('treats the same external id under a different provider as a different item', () => {
    upsertSource(
      database,
      pullRequest({ provider: 'github', externalId: 'shared-id' }),
      firstSeenAt,
    )

    upsertSource(database, pullRequest({ provider: 'gmail', externalId: 'shared-id' }), firstSeenAt)

    expect(countSources(database)).toBe(2)
  })

  it('carries a changed content hash through, which is how upstream change is detected', () => {
    upsertSource(database, pullRequest(), firstSeenAt)

    const updated = upsertSource(database, pullRequest({ contentHash: 'hash-after-a-push' }), later)

    expect(updated.contentHash).toBe('hash-after-a-push')
  })

  it('round-trips metadata as structured json rather than a string', () => {
    const source = upsertSource(database, pullRequest(), firstSeenAt)

    expect(getSource(database, source.id)?.metadata).toEqual({
      repository: 'octo/widgets',
      number: 42,
    })
  })

  it('stores no content when the content policy withheld it', () => {
    const source = upsertSource(database, pullRequest(), firstSeenAt)

    expect(source.content).toBeNull()
  })

  it('links to a task when the connector created one', () => {
    const task = createTask(
      database,
      { title: 'Review PR 42', status: 'review', statusSetBy: 'sync' },
      firstSeenAt,
    )

    const source = upsertSource(database, pullRequest({ taskId: task.id }), firstSeenAt)

    expect(listSourcesForTask(database, task.id).map((found) => found.id)).toEqual([source.id])
  })

  // An omitted field and an explicit null mean different things: the first is "I do not
  // know", the second is "it is gone upstream".
  it('keeps a stored field the caller omitted', () => {
    upsertSource(database, pullRequest(), firstSeenAt)

    const updated = upsertSource(
      database,
      { provider: 'github', externalId: 'octo/widgets#42' },
      later,
    )

    expect(updated.title).toBe('Cache the widget index')
    expect(updated.url).toBe('https://github.com/octo/widgets/pull/42')
  })

  it('clears a stored field the caller passed as null', () => {
    upsertSource(database, pullRequest({ lifecycleState: 'review_requested' }), firstSeenAt)

    const updated = upsertSource(database, pullRequest({ url: null, lifecycleState: null }), later)

    expect(updated.url).toBeNull()
    expect(updated.lifecycleState).toBeNull()
    expect(getSource(database, updated.id)?.url).toBeNull()
  })

  it('unlinks the task when the caller passes a null task id', () => {
    const task = createTask(
      database,
      { title: 'Review PR 42', status: 'review', statusSetBy: 'sync' },
      firstSeenAt,
    )
    upsertSource(database, pullRequest({ taskId: task.id }), firstSeenAt)

    const updated = upsertSource(database, pullRequest({ taskId: null }), later)

    expect(updated.taskId).toBeNull()
    expect(listSourcesForTask(database, task.id)).toEqual([])
  })

  it('exists happily with no task, as a calendar event does', () => {
    const source = upsertSource(
      database,
      pullRequest({ provider: 'gcal', externalId: 'event-1', taskId: null }),
      firstSeenAt,
    )

    expect(source.taskId).toBeNull()
  })
})

describe('getSourceByExternalId', () => {
  it('reports null for an item never seen', () => {
    expect(getSourceByExternalId(database, 'github', 'octo/widgets#99')).toBeNull()
  })
})

describe('markSourceResolved', () => {
  // Sync never deletes. An upstream item that disappears is resolved, not removed.
  it('stamps resolved_at rather than removing the row', () => {
    const source = upsertSource(database, pullRequest(), firstSeenAt)

    markSourceResolved(database, source.id, later)

    expect(getSource(database, source.id)?.resolvedAt).toBe(later)
    expect(countSources(database)).toBe(1)
  })

  it('reports null for a source that does not exist', () => {
    expect(markSourceResolved(database, 'nonexistent', later)).toBeNull()
  })
})

describe('markSourceActed', () => {
  /**
   * The marker is what lets sync tell "nothing has happened since you reviewed it" from
   * "the author has pushed since". Without it, every refresh would look like new activity.
   */
  it('records when the user acted and where upstream was at the time', () => {
    const source = upsertSource(database, pullRequest(), firstSeenAt)

    markSourceActed(database, source.id, { at: later, marker: 'sha-of-head-when-reviewed' })

    const acted = getSource(database, source.id)
    expect(acted?.actedAt).toBe(later)
    expect(acted?.actedAtMarker).toBe('sha-of-head-when-reviewed')
  })

  it('leaves the lifecycle state for the connector to set', () => {
    const source = upsertSource(
      database,
      pullRequest({ lifecycleState: 'awaiting_review' }),
      firstSeenAt,
    )

    markSourceActed(database, source.id, { at: later, marker: 'sha-of-head-when-reviewed' })

    expect(getSource(database, source.id)?.lifecycleState).toBe('awaiting_review')
  })

  it('reports null for a source that does not exist', () => {
    expect(markSourceActed(database, 'nonexistent', { at: later, marker: 'sha' })).toBeNull()
  })
})

describe('a source whose task is deleted', () => {
  /**
   * The source row is the record that this item has already been seen. Losing it would let
   * the next sync capture the item the user just deleted all over again.
   */
  it('survives, with its task link cleared', () => {
    const task = createTask(
      database,
      { title: 'Review PR 42', status: 'review', statusSetBy: 'sync' },
      firstSeenAt,
    )
    const source = upsertSource(database, pullRequest({ taskId: task.id }), firstSeenAt)

    deleteTask(database, task.id)

    expect(getSource(database, source.id)?.taskId).toBeNull()
  })
})

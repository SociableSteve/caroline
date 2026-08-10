/**
 * The Gmail connector against recorded fixtures, through the real engine and a real database.
 * Spec 02's Gmail scope, and spec 09's store boundary where it meets an item with a body.
 */
import { describe, expect, it } from 'vitest'
import type { ContentPolicy } from '../../../src/config/content.js'
import { runSync } from '../../../src/connectors/engine.js'
import { createGmailConnector } from '../../../src/connectors/gmail/connector.js'
import {
  NO_SUBJECT,
  threadBody,
  toSourceItem,
  toThreadMetadata,
} from '../../../src/connectors/gmail/map.js'
import type { Database } from '../../../src/db/connection.js'
import {
  getSourceByExternalId,
  listUnresolvedSources,
} from '../../../src/db/repositories/sources.js'
import { changeTaskStatus, getTask, listTasks } from '../../../src/db/repositories/tasks.js'
import { knownThreads } from '../../../src/jobs/registry.js'
import { fakeGmailApi, gmailFixture } from '../../helpers/gmail.js'
import { migratedDatabase } from '../../helpers/temp-database.js'

const RUN = Date.UTC(2026, 7, 10, 9, 0, 0)
const QUERY = 'in:inbox -category:promotions -category:social'

const storeNothing: ContentPolicy = {
  llmContent: 'snippet',
  storeContent: 'metadata',
  snippetChars: 300,
}

const storeSnippet: ContentPolicy = {
  llmContent: 'snippet',
  storeContent: 'snippet',
  snippetChars: 20,
}

function sync(
  database: Database,
  api: ReturnType<typeof fakeGmailApi>,
  options: { policy?: ContentPolicy; now?: number; needsBody?: boolean } = {},
) {
  const connector = createGmailConnector({
    api,
    isConfigured: () => true,
    query: QUERY,
    needsBody: () => options.needsBody ?? true,
    known: () => knownThreads(database),
  })

  return runSync({
    database,
    connectors: [connector],
    trigger: 'scheduled',
    policy: options.policy ?? storeNothing,
    now: () => options.now ?? RUN,
  })
}

describe('mapping a recorded thread', () => {
  it('keeps the metadata spec 02 asks for and no body among it', () => {
    const metadata = toThreadMetadata(gmailFixture('thread-hub-numbers'))

    expect(metadata).toEqual({
      threadId: 'thread-hub-numbers',
      subject: 'Hub numbers before Thursday',
      from: 'Sam Reed <sam.reed@example.com>',
      participants: [
        'Sam Reed <sam.reed@example.com>',
        'you@example.com',
        'Priya Nair <priya.nair@example.com>',
      ],
      messageCount: 2,
      lastMessageAt: 1786104000000,
      labels: ['IMPORTANT', 'INBOX', 'SENT', 'UNREAD'],
    })
  })

  it('reads the body of the last message, which is what needs doing about', () => {
    expect(threadBody(gmailFixture('thread-hub-numbers'))).toBe(
      'Yes, I will pull them together this afternoon.',
    )
  })

  it('prefers plain text over the HTML alternative', () => {
    const thread = gmailFixture('thread-hub-numbers')
    const firstMessageOnly = { ...thread, messages: [thread.messages?.[0]] } as typeof thread

    expect(threadBody(firstMessageOnly)).toBe(
      'Could you take a look at the hub numbers before Thursday?',
    )
  })

  it('skips an attachment while reading the text beside it', () => {
    expect(threadBody(gmailFixture('thread-invoice'))).toBe(
      'Invoice 2026-118 is attached. No action needed, filing only.',
    )
  })

  it('captures into the inbox, attributed to sync and awaiting classification', () => {
    const item = toSourceItem(gmailFixture('thread-invoice'))

    expect(item).toMatchObject({
      externalId: 'thread-invoice',
      title: 'Invoice 2026-118',
      url: 'https://mail.google.com/mail/u/0/#all/thread-invoice',
      task: { status: 'inbox' },
    })
  })

  it('gives a thread with no subject something to show on a card', () => {
    const item = toSourceItem({ id: 'thread-bare', messages: [{ id: 'm', payload: {} }] })

    expect(item.title).toBe(NO_SUBJECT)
  })
})

describe('a Gmail sync', () => {
  it('creates one inbox task per thread, attributed to sync', async () => {
    const database = migratedDatabase()
    const api = fakeGmailApi({ listings: [['thread-hub-numbers', 'thread-invoice']] })

    const summary = await sync(database, api)

    expect(api.queries).toEqual([QUERY])
    expect(summary.results[0]).toMatchObject({
      provider: 'gmail',
      status: 'success',
      counts: { itemsSeen: 2, sourcesCreated: 2, tasksCreated: 2 },
    })

    const tasks = listTasks(database, {}, RUN).tasks
    expect(tasks.map((task) => [task.status, task.statusSetBy])).toEqual([
      ['inbox', 'sync'],
      ['inbox', 'sync'],
    ])
  })

  /** Spec 02, criterion 1. */
  it('produces one row per thread over two runs, with last_seen_at advanced', async () => {
    const database = migratedDatabase()
    const api = fakeGmailApi({ listings: [['thread-hub-numbers']] })

    await sync(database, api)
    await sync(database, api, { now: RUN + 900_000 })

    expect(listTasks(database, {}, RUN).total).toBe(1)
    const source = getSourceByExternalId(database, 'gmail', 'thread-hub-numbers')
    expect(source).toMatchObject({ firstSeenAt: RUN, lastSeenAt: RUN + 900_000 })
  })

  /**
   * Spec 02: a thread leaving the query's result set has been archived or otherwise handled in
   * Gmail, so completion is proposed rather than the work being quietly lost.
   */
  it('proposes completion for a thread that has left the query', async () => {
    const database = migratedDatabase()
    const api = fakeGmailApi({
      listings: [['thread-hub-numbers', 'thread-invoice'], ['thread-invoice']],
    })

    await sync(database, api)
    const summary = await sync(database, api, { now: RUN + 900_000 })

    expect(summary.results[0]?.counts).toMatchObject({ resolved: 1 })
    const source = getSourceByExternalId(database, 'gmail', 'thread-hub-numbers')
    expect(source).toMatchObject({
      resolvedAt: RUN + 900_000,
      completionProposedAt: RUN + 900_000,
      // The row it carried is intact: a resolution item must not blank what it resolves.
      title: 'Hub numbers before Thursday',
      url: 'https://mail.google.com/mail/u/0/#all/thread-hub-numbers',
    })
    expect(getTask(database, source?.taskId ?? '')).toMatchObject({ status: 'done' })
  })

  it('stops following a resolved thread', async () => {
    const database = migratedDatabase()
    const api = fakeGmailApi({ listings: [['thread-hub-numbers'], []] })

    await sync(database, api)
    await sync(database, api, { now: RUN + 900_000 })

    expect(listUnresolvedSources(database, 'gmail')).toEqual([])
  })

  /** Spec 02, criterion 4's other half: a task the user has decided on is left where they put it. */
  it('does not complete a thread task the user has since filed themselves', async () => {
    const database = migratedDatabase()
    const api = fakeGmailApi({ listings: [['thread-hub-numbers'], []] })

    await sync(database, api)
    const taskId = getSourceByExternalId(database, 'gmail', 'thread-hub-numbers')?.taskId ?? ''
    changeTaskStatus(database, taskId, { status: 'someday', by: 'user', at: RUN + 1000 })

    await sync(database, api, { now: RUN + 900_000 })

    expect(getTask(database, taskId)).toMatchObject({ status: 'someday', statusSetBy: 'user' })
    expect(getSourceByExternalId(database, 'gmail', 'thread-hub-numbers')).toMatchObject({
      completionProposedAt: RUN + 900_000,
    })
  })

  /**
   * Spec 02: Gmail declares no tracked statuses, so it owns no transitions. A thread that is still
   * in the result set does not get dragged back to the inbox on every pass.
   */
  it('never moves a task it has already captured', async () => {
    const database = migratedDatabase()
    const api = fakeGmailApi({ listings: [['thread-hub-numbers']] })

    await sync(database, api)
    const taskId = getSourceByExternalId(database, 'gmail', 'thread-hub-numbers')?.taskId ?? ''
    changeTaskStatus(database, taskId, { status: 'next_action', by: 'user', at: RUN + 1000 })

    await sync(database, api, { now: RUN + 900_000 })

    expect(getTask(database, taskId)).toMatchObject({ status: 'next_action', statusSetBy: 'user' })
  })

  /** Spec 02, criterion 5. */
  it('records a listing failure with its message and leaves nothing behind', async () => {
    const database = migratedDatabase()
    const api = fakeGmailApi({ listings: [[]], failWith: new Error('Gmail answered 401') })

    const summary = await sync(database, api)

    expect(summary.results[0]).toMatchObject({
      provider: 'gmail',
      status: 'failure',
      error: 'Gmail answered 401',
    })
    expect(listTasks(database, {}, RUN).total).toBe(0)
  })

  /** Spec 02, criterion 6. */
  it('is skipped, not failed, when nothing is configured', async () => {
    const database = migratedDatabase()
    const api = fakeGmailApi({ listings: [['thread-hub-numbers']] })
    const connector = createGmailConnector({
      api,
      isConfigured: () => false,
      query: QUERY,
      needsBody: () => true,
      known: () => knownThreads(database),
    })

    const summary = await runSync({
      database,
      connectors: [connector],
      trigger: 'scheduled',
      policy: storeNothing,
      now: () => RUN,
    })

    expect(summary.results[0]).toMatchObject({ status: 'skipped', error: null })
    expect(api.queries).toEqual([])
  })
})

describe('the store boundary over a thread with a body', () => {
  /** Spec 09, criterion 3. */
  it('stores no body at all under the default policy', async () => {
    const database = migratedDatabase()
    const api = fakeGmailApi({ listings: [['thread-hub-numbers']] })

    await sync(database, api)

    expect(getSourceByExternalId(database, 'gmail', 'thread-hub-numbers')).toMatchObject({
      content: null,
      contentLevel: 'metadata',
      contentStoredAt: null,
    })
  })

  it('stores a snippet, cut to the configured length, when the policy allows one', async () => {
    const database = migratedDatabase()
    const api = fakeGmailApi({ listings: [['thread-hub-numbers']] })

    await sync(database, api, { policy: storeSnippet })

    expect(getSourceByExternalId(database, 'gmail', 'thread-hub-numbers')).toMatchObject({
      content: 'Yes, I will pull the',
      contentLevel: 'snippet',
      contentStoredAt: RUN,
    })
  })

  it('asks Gmail for metadata only when no policy wants a body', async () => {
    const database = migratedDatabase()
    const api = fakeGmailApi({ listings: [['thread-hub-numbers']] })

    await sync(database, api, {
      needsBody: false,
      policy: { llmContent: 'metadata', storeContent: 'metadata', snippetChars: 300 },
    })

    expect(api.formats).toEqual(['metadata'])
  })

  it('asks for the full thread when a policy wants a body', async () => {
    const database = migratedDatabase()
    const api = fakeGmailApi({ listings: [['thread-hub-numbers']] })

    await sync(database, api)

    expect(api.formats).toEqual(['full'])
  })
})

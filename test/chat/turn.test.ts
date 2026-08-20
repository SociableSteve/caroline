/**
 * The turn loop: what a conversation does, what it refuses to do on its own, and what it leaves
 * behind. Spec 07's acceptance criteria are asserted here, each against the thing it is about.
 */
import { describe, expect, it } from 'vitest'
import { getTranscript, listConversations } from '../../src/db/repositories/chat.js'
import { latestDailyPlan, recordDailyPlan } from '../../src/db/repositories/daily-plans.js'
import { createProject, getProject } from '../../src/db/repositories/projects.js'
import { setUserName } from '../../src/db/repositories/settings.js'
import { listSourcesForTask, upsertSource } from '../../src/db/repositories/sources.js'
import { createTask, getTask, getTaskTags, setTaskTags } from '../../src/db/repositories/tasks.js'
import { listLlmCalls } from '../../src/db/repositories/llm-calls.js'
import { LlmError } from '../../src/llm/types.js'
import {
  chatHarness,
  CHAT_NOW,
  doneEvent,
  eventsOfType,
  ITEM_TEXT,
  seedItemText,
  streamedText,
  textAnswer,
  toolAnswer,
} from '../helpers/chat.js'
import { migratedDatabase } from '../helpers/temp-database.js'
import type { Message } from '../../src/llm/types.js'

/** What a tool told the model, read off the turn the results travelled in. */
function toolResultText(message: Message | undefined): string {
  const result = message?.toolResults?.[0]
  if (result === undefined) throw new Error('that message carried no tool result')
  return result.content
}

describe('a turn', () => {
  it('streams the answer and records it', async () => {
    const harness = chatHarness({ answers: [textAnswer('Your inbox has three things in it.')] })

    const events = await harness.turn('What is in my inbox?')

    expect(streamedText(events)).toBe('Your inbox has three things in it.')
    expect(doneEvent(events).message).toMatchObject({
      role: 'assistant',
      content: 'Your inbox has three things in it.',
      toolCalls: 0,
      error: null,
    })
  })

  it('titles a new conversation from the first thing the user said', async () => {
    const harness = chatHarness({ answers: [textAnswer('Two.')] })

    await harness.turn('How many reviews are waiting on me?')

    expect(listConversations(harness.database)).toMatchObject([
      { title: 'How many reviews are waiting on me?', messageCount: 2 },
    ])
  })

  it('carries on an existing conversation rather than starting another', async () => {
    const harness = chatHarness({ answers: [textAnswer('One.'), textAnswer('Two.')] })
    const first = doneEvent(await harness.turn('First question'))

    await harness.turn('Second question', first.conversation.id)

    expect(listConversations(harness.database)).toHaveLength(1)
    expect(getTranscript(harness.database, first.conversation.id)?.messages).toHaveLength(4)
  })

  it('refuses a conversation id that names nothing', async () => {
    const harness = chatHarness({ answers: [textAnswer('One.')] })
    const events: unknown[] = []

    const refusal = await harness.service.turn(
      { conversationId: 'nope', message: 'Hello' },
      (event) => events.push(event),
    )

    expect(refusal).toBe('no-such-conversation')
    expect(events).toEqual([])
  })

  /** Criterion 8, and spec 08 criterion 7: the conversation is the record, not the connection. */
  it('reopens with its full transcript, which is what survives a restart', async () => {
    const harness = chatHarness({ answers: [textAnswer('Answered.')] })
    const done = doneEvent(await harness.turn('A question'))

    const transcript = getTranscript(harness.database, done.conversation.id)

    expect(transcript?.messages.map((message) => [message.role, message.content])).toEqual([
      ['user', 'A question'],
      ['assistant', 'Answered.'],
    ])
  })

  it('says so plainly when no model is configured', async () => {
    const harness = chatHarness({ answers: [], configured: false })

    const events = await harness.turn('Anything?')

    expect(streamedText(events)).toContain('No language model is configured')
    expect(doneEvent(events).message).toMatchObject({ readOnly: true, error: expect.any(String) })
  })

  /**
   * A provider that failed part-way is a fact about the turn. The text that arrived is kept, because
   * blanking it would be a second inaccuracy on top of the first.
   */
  it('keeps what a failed turn managed to say, and records why it stopped', async () => {
    const harness = chatHarness({
      answers: [
        { throws: new LlmError('the provider is down') },
        { throws: new LlmError('the provider is down') },
      ],
    })

    const events = await harness.turn('A question')

    expect(eventsOfType(events, 'error')[0]?.message).toContain('the provider is down')
    expect(doneEvent(events).message.error).toContain('the provider is down')
  })

  /**
   * A connection failure before anything has come back is commonly transient, so it is worth one
   * retry rather than failing the turn on the first attempt. "Anthropic call failed: Connection
   * error." is exactly this case: nothing has reached the client yet when it happens.
   */
  it('retries once when the provider fails before answering anything', async () => {
    const harness = chatHarness({
      answers: [{ throws: new LlmError('Connection error.') }, textAnswer('Answered.')],
    })

    const events = await harness.turn('A question')

    expect(streamedText(events)).toBe('Answered.')
    expect(eventsOfType(events, 'error')).toEqual([])
    expect(doneEvent(events).message.error).toBeNull()
  })

  /** The retry is a single extra attempt, not a loop: a second failure still surfaces. */
  it('gives up after the retry also fails', async () => {
    const harness = chatHarness({
      answers: [
        { throws: new LlmError('Connection error.') },
        { throws: new LlmError('Connection error.') },
        textAnswer('Would have answered.'),
      ],
    })

    const events = await harness.turn('A question')

    expect(streamedText(events)).toBe('')
    expect(eventsOfType(events, 'error')[0]?.message).toContain('Connection error.')
    expect(doneEvent(events).message.error).toContain('Connection error.')
  })

  /**
   * Once text has reached the client, retrying would run a second answer on top of the first.
   * A failure past that point is left to surface as-is rather than risk a doubled-up answer.
   */
  it('does not retry once the provider has already started answering', async () => {
    const harness = chatHarness({
      answers: [{ partial: 'Partway', throws: new LlmError('the connection dropped') }],
    })

    const events = await harness.turn('A question')

    expect(streamedText(events)).toBe('Partway')
    expect(eventsOfType(events, 'error')[0]?.message).toContain('the connection dropped')
  })

  /** Spec 03, criterion 7: a streamed call spent tokens, so it is recorded like any other. */
  it('records the provider calls it made', async () => {
    const database = migratedDatabase()
    // The recorder lives in the runtime, which the harness replaces, so the usage totals on the
    // conversation are the thing this can assert here. `test/llm/runtime.test.ts` covers the row.
    const harness = chatHarness({ answers: [textAnswer('Answered.')], database })

    const done = doneEvent(await harness.turn('A question'))

    expect(done.conversation).toMatchObject({ inputTokens: 7, outputTokens: 3 })
    expect(listLlmCalls(database)).toEqual([])
  })

  it('sends the counts, the plan and the capacity, and no task titles', async () => {
    const harness = chatHarness({ answers: [textAnswer('Answered.')] })
    createTask(harness.database, { id: 'task-1', title: 'A very distinctive title' }, CHAT_NOW)

    await harness.turn('What is in my inbox?')

    const system = harness.requests[0]?.system ?? ''
    expect(system).toContain('taskCountsByStatus')
    expect(system).toContain('todaysCapacity')
    // Spec 09: detail reaches the model only through a tool it chose to call.
    expect(system).not.toContain('A very distinctive title')
  })
})

describe('a turn that uses tools', () => {
  it('feeds the tool result back and answers from it', async () => {
    const harness = chatHarness({
      answers: [
        toolAnswer([{ name: 'search_tasks', arguments: { query: 'venue' } }]),
        textAnswer('One task mentions the venue.'),
      ],
    })
    createTask(harness.database, { id: 'task-1', title: 'Book the venue' }, CHAT_NOW)

    const events = await harness.turn('Anything about the venue?')

    expect(eventsOfType(events, 'tool')).toMatchObject([{ name: 'search_tasks', outcome: 'ok' }])
    // The second request carries the assistant's call and the result beside it, which is what lets
    // the model answer from data it fetched.
    const second = harness.requests[1]
    expect(second?.messages.at(-2)).toMatchObject({ toolCalls: [{ name: 'search_tasks' }] })
    expect(JSON.stringify(second?.messages.at(-1))).toContain('Book the venue')
    expect(doneEvent(events).message).toMatchObject({
      content: 'One task mentions the venue.',
      toolCalls: 1,
    })
  })

  it('records what it changed against the turn', async () => {
    const harness = chatHarness({
      answers: [
        toolAnswer([{ name: 'create_task', arguments: { title: 'Book the venue' } }]),
        textAnswer('Added it to your inbox.'),
      ],
    })

    const events = await harness.turn('Add a task to book the venue')

    expect(eventsOfType(events, 'change')).toMatchObject([
      { change: { summary: 'Created “Book the venue” in inbox', entity: 'task', undoable: true } },
    ])
    expect(doneEvent(events).message.changes).toHaveLength(1)
  })

  /** Spec 08, criterion 5: a change made anywhere reaches the open board without a refresh. */
  it('announces a change so the rest of the UI reloads', async () => {
    const harness = chatHarness({
      answers: [
        toolAnswer([{ name: 'create_task', arguments: { title: 'Book the venue' } }]),
        textAnswer('Done.'),
      ],
    })

    await harness.turn('Add a task')

    expect(harness.published.map((event) => event.kind)).toEqual(['tasks', 'projects'])
  })

  it('announces nothing when it only read', async () => {
    const harness = chatHarness({
      answers: [toolAnswer([{ name: 'search_tasks', arguments: {} }]), textAnswer('Nothing.')],
    })

    await harness.turn('Anything in the inbox?')

    expect(harness.published).toEqual([])
  })

  /** Spec 07: a malformed call returns a structured error to the model, which may try again. */
  it('gives a malformed call back to the model as an error it can act on', async () => {
    const harness = chatHarness({
      answers: [
        toolAnswer([{ name: 'create_task', arguments: { notATitle: 'oops' } }]),
        toolAnswer([{ name: 'create_task', arguments: { title: 'Book the venue' } }]),
        textAnswer('Added it.'),
      ],
    })

    const events = await harness.turn('Add a task')

    expect(eventsOfType(events, 'tool').map((event) => event.outcome)).toEqual(['refused', 'ok'])
    expect(toolResultText(harness.requests[1]?.messages.at(-1))).toContain(
      'did not match its schema',
    )
    expect(doneEvent(events).message.changes).toHaveLength(1)
  })

  it('tells the model when it named a tool that does not exist', async () => {
    const harness = chatHarness({
      answers: [
        toolAnswer([{ name: 'send_email', arguments: { to: 'ana' } }]),
        textAnswer('I cannot do that.'),
      ],
    })

    const events = await harness.turn('Email Ana')

    expect(eventsOfType(events, 'tool')).toMatchObject([{ name: 'send_email', outcome: 'refused' }])
    expect(toolResultText(harness.requests[1]?.messages.at(-1))).toContain(
      'There is no tool called send_email',
    )
  })

  /** Criterion 6. */
  it('stops at the tool-call cap, says so, and leaves what it did applied', async () => {
    const harness = chatHarness({
      file: { chat: { maxToolCalls: 2 } },
      answers: [
        toolAnswer([{ name: 'create_task', arguments: { title: 'First' } }]),
        toolAnswer([{ name: 'create_task', arguments: { title: 'Second' } }]),
        toolAnswer([{ name: 'create_task', arguments: { title: 'Third' } }]),
      ],
    })

    const events = await harness.turn('Add three tasks')
    const message = doneEvent(events).message

    expect(message.toolCallLimitReached).toBe(true)
    expect(message.toolCalls).toBe(2)
    expect(message.content).toContain('limit of 2 tool calls')
    // The two that ran are done, and the third never happened.
    expect(message.changes.map((change) => change.summary)).toEqual([
      'Created “First” in inbox',
      'Created “Second” in inbox',
    ])
  })

  /**
   * The turn gets one more request once its budget is spent, so that the model can say what it did.
   * It is told so in a message, and the tools stay declared: Anthropic refuses a request whose
   * messages carry tool blocks and no `tools` field, so withdrawing them would turn a capped turn
   * into a failed one on that provider alone.
   */
  it('tells the model its budget is spent, and keeps the tools declared while it answers', async () => {
    const harness = chatHarness({
      file: { chat: { maxToolCalls: 1 } },
      answers: [
        toolAnswer([{ name: 'create_task', arguments: { title: 'First' } }]),
        textAnswer('I added the first one.'),
      ],
    })

    const events = await harness.turn('Add a task')

    expect(harness.requests).toHaveLength(2)
    expect(harness.requests[1]?.messages.at(-1)).toMatchObject({
      role: 'user',
      content: expect.stringContaining('used all 1 tool calls'),
    })
    expect(harness.requests[1]?.tools).toBeDefined()
    expect(doneEvent(events).message.content).toContain('I added the first one.')
    expect(doneEvent(events).message.content).toContain('limit of 1 tool calls')
  })

  /** The cap holds even if the model asks anyway on the pass where it was told to stop. */
  it('runs nothing more when the model calls a tool after being told to stop', async () => {
    const harness = chatHarness({
      file: { chat: { maxToolCalls: 1 } },
      answers: [
        toolAnswer([{ name: 'create_task', arguments: { title: 'First' } }]),
        toolAnswer([{ name: 'create_task', arguments: { title: 'Second' } }], 'One more.'),
      ],
    })

    const events = await harness.turn('Add two tasks')

    expect(doneEvent(events).message.changes.map((change) => change.summary)).toEqual([
      'Created “First” in inbox',
    ])
    expect(harness.requests).toHaveLength(2)
  })
})

describe('a delete a turn proposes', () => {
  function deleteHarness() {
    const harness = chatHarness({
      answers: [
        toolAnswer([{ name: 'delete_task', arguments: { id: 'task-1' } }]),
        textAnswer('I have asked you to confirm that.'),
      ],
    })
    createTask(harness.database, { id: 'task-1', title: 'Book the venue' }, CHAT_NOW)
    return harness
  }

  /** Criterion 3. */
  it('is not executed until the user confirms', async () => {
    const harness = deleteHarness()

    const events = await harness.turn('Delete the venue task')

    expect(getTask(harness.database, 'task-1')).not.toBeNull()
    expect(eventsOfType(events, 'confirmation')).toMatchObject([
      {
        confirmation: {
          reason: 'delete',
          affectedCount: 1,
          summary: 'Delete “Book the venue”',
          decision: null,
        },
      },
    ])
    expect(eventsOfType(events, 'change')).toEqual([])
  })

  it('tells the model it was held rather than done, so it cannot claim otherwise', async () => {
    const harness = deleteHarness()

    await harness.turn('Delete the venue task')

    const result = toolResultText(harness.requests[1]?.messages.at(-1))
    expect(result).toContain('Nothing was deleted')
    expect(JSON.parse(result)).toMatchObject({ held: true })
  })

  it('deletes it when the user confirms, and records the change against the same turn', async () => {
    const harness = deleteHarness()
    const events = await harness.turn('Delete the venue task')
    const confirmation = eventsOfType(events, 'confirmation')[0]?.confirmation
    const turnId = doneEvent(events).message.id

    const result = await harness.service.confirm(confirmation?.id ?? '', true)

    expect(result).toMatchObject({ resolved: true, failures: [] })
    expect(getTask(harness.database, 'task-1')).toBeNull()
    const transcript = getTranscript(harness.database, doneEvent(events).conversation.id)
    expect(transcript?.messages.find((message) => message.id === turnId)?.changes).toMatchObject([
      { summary: 'Deleted “Book the venue”' },
    ])
  })

  it('deletes nothing when the user discards it, and says the decision was made', async () => {
    const harness = deleteHarness()
    const events = await harness.turn('Delete the venue task')
    const confirmation = eventsOfType(events, 'confirmation')[0]?.confirmation

    const result = await harness.service.confirm(confirmation?.id ?? '', false)

    expect(result).toMatchObject({ resolved: true, confirmation: { decision: 'rejected' } })
    expect(getTask(harness.database, 'task-1')).not.toBeNull()
  })

  /**
   * The row is decided before the operation runs, so a failure that is not a refusal has to be
   * reported rather than escaping: a 500 against a confirmation that can never be retried would
   * leave the user unable to find out what happened.
   */
  /**
   * The row is consumed by the decision, so a batch that does not read back cannot be offered again.
   * Saying nothing ran is the only honest answer; reporting success would leave the user believing a
   * delete happened.
   */
  it('reports a failure when what was proposed cannot be read back', async () => {
    const harness = deleteHarness()
    const events = await harness.turn('Delete the venue task')
    const id = eventsOfType(events, 'confirmation')[0]?.confirmation.id ?? ''
    harness.database
      .prepare('update chat_confirmations set arguments = ? where id = ?')
      .run('{"operations":"not a list"}', id)

    const result = await harness.service.confirm(id, true)

    expect(result).toMatchObject({
      resolved: true,
      changes: [],
      failures: [expect.stringContaining('could not be read back')],
    })
    expect(getTask(harness.database, 'task-1')).not.toBeNull()
  })

  it('reports a failure inside the operation rather than escaping', async () => {
    const harness = deleteHarness()
    const events = await harness.turn('Delete the venue task')
    const id = eventsOfType(events, 'confirmation')[0]?.confirmation.id ?? ''
    // The one failure a delete cannot recover from: the table it writes its record to has gone.
    harness.database.exec('drop table chat_changes')

    const result = await harness.service.confirm(id, true)

    expect(result).toMatchObject({
      resolved: true,
      failures: [expect.stringContaining('delete_task could not be carried out')],
    })
  })

  it('cannot be confirmed twice', async () => {
    const harness = deleteHarness()
    const events = await harness.turn('Delete the venue task')
    const id = eventsOfType(events, 'confirmation')[0]?.confirmation.id ?? ''
    await harness.service.confirm(id, true)

    expect(await harness.service.confirm(id, true)).toMatchObject({
      resolved: false,
      reason: 'already-decided',
    })
  })

  it('reports an operation that can no longer be carried out', async () => {
    const harness = deleteHarness()
    const events = await harness.turn('Delete the venue task')
    const id = eventsOfType(events, 'confirmation')[0]?.confirmation.id ?? ''
    // Somebody deleted it from the board while the confirmation sat on the screen.
    harness.database.prepare('delete from tasks where id = ?').run('task-1')

    const result = await harness.service.confirm(id, true)

    expect(result).toMatchObject({
      resolved: true,
      changes: [],
      failures: [expect.stringContaining('no task with the id task-1')],
    })
  })
})

/** Criterion 4. */
describe('a turn that changes more tasks than the threshold', () => {
  async function bulkTurn() {
    const harness = chatHarness({
      file: { chat: { bulkConfirmThreshold: 2 } },
      answers: [
        toolAnswer([
          { name: 'complete_task', arguments: { id: 'task-1' }, id: 'c1' },
          { name: 'complete_task', arguments: { id: 'task-2' }, id: 'c2' },
          { name: 'complete_task', arguments: { id: 'task-3' }, id: 'c3' },
          { name: 'complete_task', arguments: { id: 'task-4' }, id: 'c4' },
        ]),
        textAnswer('Two done, two waiting on you.'),
      ],
    })

    for (const number of [1, 2, 3, 4]) {
      createTask(harness.database, { id: `task-${number}`, title: `Task ${number}` }, CHAT_NOW)
    }

    const events = await harness.turn('Complete all four')
    return { harness, events }
  }

  it('applies up to the threshold and holds the rest for confirmation', async () => {
    const { harness } = await bulkTurn()

    expect(getTask(harness.database, 'task-1')?.status).toBe('done')
    expect(getTask(harness.database, 'task-2')?.status).toBe('done')
    expect(getTask(harness.database, 'task-3')?.status).toBe('inbox')
    expect(getTask(harness.database, 'task-4')?.status).toBe('inbox')
  })

  it('collects them into one confirmation which states how many items are affected', async () => {
    const { events } = await bulkTurn()
    const confirmations = eventsOfType(events, 'confirmation')

    // One confirmation, updated as more of the turn was held, rather than one prompt per call.
    const distinct = new Set(confirmations.map((event) => event.confirmation.id))
    expect(distinct.size).toBe(1)

    const latest = confirmations.at(-1)?.confirmation
    // The count is what confirming would do: the two held calls. The turn's total is in the words.
    expect(latest).toMatchObject({ reason: 'bulk', affectedCount: 2 })
    expect(latest?.summary).toContain('would change 4 tasks')
    expect(latest?.summary).toContain('more than the 2')
    expect(latest?.summary).toContain('remaining 2')
  })

  /**
   * The threshold counts tasks, so a write that changes none of them is not held by it: telling the
   * user that creating a project is one of fourteen tasks would be telling them a wrong number.
   */
  it('does not hold a write that changes no tasks', async () => {
    const harness = chatHarness({
      file: { chat: { bulkConfirmThreshold: 1 } },
      answers: [
        toolAnswer([
          { name: 'complete_task', arguments: { id: 'task-1' }, id: 'c1' },
          { name: 'create_project', arguments: { title: 'Ship Caroline' }, id: 'c2' },
        ]),
        textAnswer('Done both.'),
      ],
    })
    createTask(harness.database, { id: 'task-1', title: 'Book the venue' }, CHAT_NOW)

    const events = await harness.turn('Complete that and start a project')

    expect(eventsOfType(events, 'confirmation')).toEqual([])
    expect(doneEvent(events).message.changes.map((change) => change.entity)).toEqual([
      'task',
      'project',
    ])
  })

  it('applies the held ones only when the user confirms', async () => {
    const { harness, events } = await bulkTurn()
    const id = eventsOfType(events, 'confirmation').at(-1)?.confirmation.id ?? ''

    const result = await harness.service.confirm(id, true)

    expect(result).toMatchObject({ resolved: true, failures: [] })
    expect(getTask(harness.database, 'task-3')?.status).toBe('done')
    expect(getTask(harness.database, 'task-4')?.status).toBe('done')
  })
})

/** Criterion 5. */
describe('undo', () => {
  it('restores the prior values of every task the turn changed', async () => {
    const harness = chatHarness({
      answers: [
        toolAnswer([
          { name: 'update_task', arguments: { id: 'task-1', status: 'next_action' }, id: 'c1' },
          {
            name: 'update_task',
            arguments: { id: 'task-2', title: 'Renamed', estimateMinutes: 90 },
            id: 'c2',
          },
        ]),
        textAnswer('Both done.'),
      ],
    })
    createTask(
      harness.database,
      { id: 'task-1', title: 'Book the venue', status: 'someday', statusSetBy: 'llm' },
      CHAT_NOW,
    )
    createTask(
      harness.database,
      { id: 'task-2', title: 'Draft the agenda', estimateMinutes: 30 },
      CHAT_NOW,
    )

    const events = await harness.turn('Move one and rename the other')
    const { message, conversation } = doneEvent(events)

    const result = harness.service.undo(conversation.id, message.id)

    expect(result.undone).toBe(true)
    expect(getTask(harness.database, 'task-1')).toMatchObject({
      status: 'someday',
      statusSetBy: 'llm',
    })
    expect(getTask(harness.database, 'task-2')).toMatchObject({
      title: 'Draft the agenda',
      estimateMinutes: 30,
    })
  })

  it('takes a created task away again', async () => {
    const harness = chatHarness({
      answers: [
        toolAnswer([{ name: 'create_task', arguments: { title: 'Book the venue' } }]),
        textAnswer('Added.'),
      ],
    })
    const events = await harness.turn('Add a task')
    const created = doneEvent(events).message.changes[0]?.entityId ?? ''

    harness.service.undo(doneEvent(events).conversation.id, doneEvent(events).message.id)

    expect(getTask(harness.database, created)).toBeNull()
  })

  it('brings back a deleted task with its tags and its provenance', async () => {
    const harness = chatHarness({
      answers: [
        toolAnswer([{ name: 'delete_task', arguments: { id: 'task-1' } }]),
        textAnswer('Asked you to confirm.'),
      ],
    })
    createTask(harness.database, { id: 'task-1', title: 'Book the venue' }, CHAT_NOW)
    setTaskTags(harness.database, 'task-1', ['errand'])
    upsertSource(
      harness.database,
      { provider: 'gmail', externalId: 'thread-1', taskId: 'task-1' },
      CHAT_NOW,
    )

    const events = await harness.turn('Delete it')
    const id = eventsOfType(events, 'confirmation')[0]?.confirmation.id ?? ''
    await harness.service.confirm(id, true)

    const result = harness.service.undo(
      doneEvent(events).conversation.id,
      doneEvent(events).message.id,
    )

    expect(result.undone).toBe(true)
    expect(getTask(harness.database, 'task-1')).toMatchObject({ title: 'Book the venue' })
    expect(getTaskTags(harness.database, 'task-1')).toEqual(['errand'])
    expect(listSourcesForTask(harness.database, 'task-1')).toHaveLength(1)
  })

  it('puts the connector’s state machine back when it undoes a mark-reviewed', async () => {
    const harness = chatHarness({
      answers: [
        toolAnswer([{ name: 'mark_reviewed', arguments: { id: 'task-1' } }]),
        textAnswer('Marked.'),
      ],
    })
    createTask(
      harness.database,
      { id: 'task-1', title: 'Review the helper', status: 'review', statusSetBy: 'sync' },
      CHAT_NOW,
    )
    upsertSource(
      harness.database,
      {
        provider: 'github',
        externalId: 'example-org/service#42',
        taskId: 'task-1',
        lifecycleState: 'awaiting_review',
        metadata: { headSha: 'abc123', author: 'ana' },
      },
      CHAT_NOW,
    )

    const events = await harness.turn('I have reviewed it')
    harness.service.undo(doneEvent(events).conversation.id, doneEvent(events).message.id)

    expect(getTask(harness.database, 'task-1')).toMatchObject({ status: 'review' })
    expect(listSourcesForTask(harness.database, 'task-1')[0]).toMatchObject({
      lifecycleState: 'awaiting_review',
      actedAt: null,
      actedAtMarker: null,
    })
  })

  it('removes a created project without leaving its tasks pointing at it', async () => {
    const harness = chatHarness({
      answers: [
        toolAnswer([{ name: 'create_project', arguments: { title: 'Ship Caroline' } }]),
        textAnswer('Created.'),
      ],
    })

    const events = await harness.turn('Start a project')
    const projectId = doneEvent(events).message.changes[0]?.entityId ?? ''

    harness.service.undo(doneEvent(events).conversation.id, doneEvent(events).message.id)

    expect(getProject(harness.database, projectId)).toBeNull()
  })

  /**
   * The snapshot is Caroline's own JSON and should always read back. If it does not, the batch has to
   * stay exactly as it was: marking it undone without undoing it would leave the task holding what
   * the turn wrote with no way left to put it back.
   */
  it('leaves the batch retryable when a stored snapshot cannot be read back', async () => {
    const harness = chatHarness({
      answers: [
        toolAnswer([{ name: 'update_task', arguments: { id: 'task-1', status: 'next_action' } }]),
        textAnswer('Moved it.'),
      ],
    })
    createTask(harness.database, { id: 'task-1', title: 'Book the venue' }, CHAT_NOW)

    const { conversation, message } = doneEvent(await harness.turn('Move it'))
    // As though the inverse had been written by a version that stored a different shape.
    harness.database
      .prepare(
        'update chat_changes set inverse = \'[{"kind":"restore-task","task":{},"tags":[]}]\'',
      )
      .run()

    expect(() => harness.service.undo(conversation.id, message.id)).toThrow(
      /could not be read back/,
    )
    expect(getTask(harness.database, 'task-1')?.status).toBe('next_action')
    // Still on offer, because nothing was recorded as having been put back.
    expect(harness.database.prepare('select undone_at from chat_changes').get()).toMatchObject({
      undone_at: null,
    })
  })

  /**
   * The lifecycle restore is the other half of a mark-reviewed, not an extra: with only the task put
   * back, the next sync reads a review that never happened as discharged. So a missing source fails
   * the undo rather than leaving the batch stamped and unretryable.
   */
  it('leaves the batch retryable when the source of a lifecycle inverse has gone', async () => {
    const harness = chatHarness({
      answers: [
        toolAnswer([{ name: 'mark_reviewed', arguments: { id: 'task-1' } }]),
        textAnswer('Marked.'),
      ],
    })
    createTask(
      harness.database,
      { id: 'task-1', title: 'Review the helper', status: 'review', statusSetBy: 'sync' },
      CHAT_NOW,
    )
    upsertSource(
      harness.database,
      {
        provider: 'github',
        externalId: 'example-org/service#42',
        taskId: 'task-1',
        lifecycleState: 'awaiting_review',
        metadata: { headSha: 'abc123', author: 'ana' },
      },
      CHAT_NOW,
    )

    const { conversation, message } = doneEvent(await harness.turn('I have reviewed it'))
    harness.database.prepare('delete from sources').run()

    expect(() => harness.service.undo(conversation.id, message.id)).toThrow(/no longer exists/)
    expect(harness.database.prepare('select undone_at from chat_changes').get()).toMatchObject({
      undone_at: null,
    })
  })

  it('marks the batch undone, and refuses to undo it twice', async () => {
    const harness = chatHarness({
      answers: [
        toolAnswer([{ name: 'create_task', arguments: { title: 'Book the venue' } }]),
        textAnswer('Added.'),
      ],
    })
    const events = await harness.turn('Add a task')
    const { conversation, message } = doneEvent(events)

    const first = harness.service.undo(conversation.id, message.id)
    const second = harness.service.undo(conversation.id, message.id)

    expect(first).toMatchObject({ undone: true, changes: [{ undoneAt: CHAT_NOW }] })
    expect(second).toMatchObject({ undone: false, reason: 'nothing-to-undo' })
  })

  /** Spec 07 offers undo for the last batch. An older one holds values from before what followed. */
  it('refuses a turn that is no longer the last one to have changed something', async () => {
    const harness = chatHarness({
      answers: [
        toolAnswer([{ name: 'create_task', arguments: { title: 'First' } }]),
        textAnswer('Added.'),
        toolAnswer([{ name: 'create_task', arguments: { title: 'Second' } }]),
        textAnswer('Added.'),
      ],
    })
    const first = doneEvent(await harness.turn('Add one'))
    await harness.turn('Add another', first.conversation.id)

    expect(harness.service.undo(first.conversation.id, first.message.id)).toMatchObject({
      undone: false,
      reason: 'not-the-last-turn',
    })
  })

  /**
   * A confirmed batch's changes belong to the turn that proposed it, so confirming after a later
   * turn has spoken makes the older turn the most recent writer. Undo has to follow the writes
   * rather than the message order, or the newer turn's inverse would revert the confirmed batch and
   * the confirmed batch could never be undone at all.
   */
  it('follows the last change rather than the last turn', async () => {
    const harness = chatHarness({
      answers: [
        toolAnswer([{ name: 'delete_task', arguments: { id: 'task-1' } }]),
        textAnswer('Asked you to confirm.'),
        toolAnswer([{ name: 'complete_task', arguments: { id: 'task-2' } }]),
        textAnswer('Completed the other one.'),
      ],
    })
    createTask(harness.database, { id: 'task-1', title: 'Book the venue' }, CHAT_NOW)
    createTask(harness.database, { id: 'task-2', title: 'Draft the agenda' }, CHAT_NOW)

    const first = await harness.turn('Delete the venue task')
    const proposed = eventsOfType(first, 'confirmation')[0]?.confirmation.id ?? ''
    const second = doneEvent(
      await harness.turn('Complete the other', doneEvent(first).conversation.id),
    )

    // The confirmation is decided last, so its changes are the newest.
    harness.advance(60_000)
    await harness.service.confirm(proposed, true)

    const conversationId = second.conversation.id
    expect(harness.service.undo(conversationId, second.message.id)).toMatchObject({
      undone: false,
      reason: 'not-the-last-turn',
    })
    expect(harness.service.undo(conversationId, doneEvent(first).message.id)).toMatchObject({
      undone: true,
    })
    expect(getTask(harness.database, 'task-1')).toMatchObject({ title: 'Book the venue' })
    // The later turn's own change stands: only the batch that was undone came back.
    expect(getTask(harness.database, 'task-2')?.status).toBe('done')
  })

  /**
   * `daily_plan_entries.task_id` is cleared by a delete rather than taken with it (migration 5), so
   * an undo that only restored the task would leave today's plan naming work it can no longer mark
   * done.
   */
  it('reattaches a restored task to the plan entries that named it', async () => {
    const harness = chatHarness({
      answers: [
        toolAnswer([{ name: 'delete_task', arguments: { id: 'task-1' } }]),
        textAnswer('Asked you to confirm.'),
      ],
    })
    createTask(harness.database, { id: 'task-1', title: 'Book the venue' }, CHAT_NOW)
    recordDailyPlan(harness.database, {
      planDate: '2026-06-01',
      generatedAt: CHAT_NOW,
      timeZone: 'Europe/London',
      windowMinutes: 510,
      busyMinutes: 0,
      reserveMinutes: 102,
      capacityMinutes: 408,
      capacityVerified: false,
      provider: null,
      model: null,
      promptVersion: '2026-08-10',
      summary: null,
      warnings: [],
      entries: [
        {
          taskId: 'task-1',
          title: 'Book the venue',
          rank: 1,
          rationale: 'It is due today.',
          estimateMinutes: 30,
        },
      ],
      overflow: [],
      nudges: [],
    })

    const events = await harness.turn('Delete it')
    await harness.service.confirm(
      eventsOfType(events, 'confirmation')[0]?.confirmation.id ?? '',
      true,
    )
    expect(latestDailyPlan(harness.database, '2026-06-01')?.entries[0]?.taskId).toBeNull()

    harness.service.undo(doneEvent(events).conversation.id, doneEvent(events).message.id)

    expect(latestDailyPlan(harness.database, '2026-06-01')?.entries[0]?.taskId).toBe('task-1')
  })

  it('has nothing to undo for a turn that only talked', async () => {
    const harness = chatHarness({ answers: [textAnswer('Nothing to do.')] })
    const { conversation, message } = doneEvent(await harness.turn('A question'))

    expect(harness.service.undo(conversation.id, message.id)).toMatchObject({
      undone: false,
      reason: 'nothing-to-undo',
    })
  })

  it('announces the restore, so the board shows what came back', async () => {
    const harness = chatHarness({
      answers: [
        toolAnswer([{ name: 'create_task', arguments: { title: 'Book the venue' } }]),
        textAnswer('Added.'),
      ],
    })
    const { conversation, message } = doneEvent(await harness.turn('Add a task'))
    const before = harness.published.length

    harness.service.undo(conversation.id, message.id)

    expect(harness.published.slice(before).map((event) => event.kind)).toEqual([
      'tasks',
      'projects',
    ])
  })
})

/** Criterion 7. */
describe('a model that cannot use tools', () => {
  it('is offered no tool at all, and the turn is recorded as read-only', async () => {
    const harness = chatHarness({
      answers: [textAnswer('I cannot make changes in this setup.')],
      supportsTools: false,
    })

    const events = await harness.turn('Complete everything in my inbox')

    expect(harness.requests[0]?.tools).toBeUndefined()
    expect(eventsOfType(events, 'turn')[0]?.readOnly).toBe(true)
    expect(doneEvent(events).message.readOnly).toBe(true)
  })

  it('is told plainly that it cannot change anything', async () => {
    const harness = chatHarness({ answers: [textAnswer('Understood.')], supportsTools: false })

    await harness.turn('Complete everything')

    expect(harness.requests[0]?.system).toContain('cannot change anything')
    expect(harness.requests[0]?.system).toContain('Never say you have changed')
  })

  it('reports chat as read-only through the service', () => {
    expect(chatHarness({ answers: [], supportsTools: false }).service.canWrite()).toBe(false)
    expect(chatHarness({ answers: [], configured: false }).service.canWrite()).toBe(false)
    expect(chatHarness({ answers: [] }).service.canWrite()).toBe(true)
  })
})

describe('the context a turn is given', () => {
  it('carries the plan and the capacity for today', async () => {
    const harness = chatHarness({ answers: [textAnswer('Answered.')] })
    createProject(harness.database, { id: 'project-1', title: 'Ship Caroline' }, CHAT_NOW)

    await harness.turn('What does today look like?')

    const system = harness.requests[0]?.system ?? ''
    expect(system).toContain('"todaysPlan": null')
    expect(system).toContain('"stalledProjects": 1')
    expect(system).toContain('Today is 2026-06-01')
  })

  /**
   * Spec 09, criterion 13, on the one line of the day's context the policy has anything to withhold:
   * a plan's summary is prose written about the day's tasks and can name one. No plan is drawn at all
   * at `none` (spec 05), so this is the plan drawn before the policy was lowered, and the level it is
   * read under is the one in force now rather than the one it was written under.
   */
  it('withholds a plan’s summary from the day’s context at none', async () => {
    const harness = chatHarness({
      answers: [textAnswer('Answered.')],
      file: { privacy: { llmContent: 'none' } },
    })
    recordDailyPlan(harness.database, {
      planDate: '2026-06-01',
      generatedAt: CHAT_NOW,
      timeZone: 'Europe/London',
      windowMinutes: 510,
      busyMinutes: 0,
      reserveMinutes: 102,
      capacityMinutes: 408,
      capacityVerified: false,
      provider: 'ollama',
      model: 'a-model',
      promptVersion: '2026-08-10',
      summary: 'A quiet day, with the Northwind contract due.',
      warnings: [],
      entries: [],
      overflow: [],
      nudges: [],
    })

    await harness.turn('What does today look like?')

    const system = harness.requests[0]?.system ?? ''
    expect(system).not.toContain('Northwind')
    // The arithmetic is nobody's content and still goes, so the day is still answerable.
    expect(system).toContain('"capacityMinutes": 408')
  })

  /**
   * Spec 09: the shared preamble names the person using Caroline. Without it a model writes about
   * the user in the third person to the user's own face, and the name is also personal data leaving
   * the machine, which is why it is asserted against the built request rather than the template.
   */
  it('names the person it is talking to, from the settings table', async () => {
    const harness = chatHarness({ answers: [textAnswer('Answered.')] })
    setUserName(harness.database, 'Steve', CHAT_NOW)

    await harness.turn('What is in my inbox?')

    expect(harness.requests[0]?.system).toContain('"Steve"')
  })

  it('says it does not know the name when nobody has given one', async () => {
    const harness = chatHarness({ answers: [textAnswer('Answered.')] })

    await harness.turn('What is in my inbox?')

    expect(harness.requests[0]?.system).toMatch(/do not know their name/i)
  })

  it('bounds how much of a long conversation goes back to the model', async () => {
    const harness = chatHarness({
      file: { chat: { contextMessages: 2 } },
      answers: [textAnswer('One.'), textAnswer('Two.'), textAnswer('Three.')],
    })
    const first = doneEvent(await harness.turn('First'))
    await harness.turn('Second', first.conversation.id)
    await harness.turn('Third', first.conversation.id)

    // Two messages, minus the empty turn in progress, so the model sees the recent thread and not
    // the whole week.
    expect(harness.requests.at(-1)?.messages.length).toBeLessThanOrEqual(2)
    expect(JSON.stringify(harness.requests.at(-1)?.messages)).not.toContain('First')
  })
})

/**
 * The item the user had open when they sent the message. Spec 07's rules for it: resolved per message,
 * recorded as what was sent rather than as an id, and never carried over from an earlier turn.
 */
describe('the item a turn is talking about', () => {
  /** Criterion 9. */
  it('carries the selected item in the built request', async () => {
    const harness = chatHarness({ answers: [textAnswer('It is in your inbox.')] })
    createTask(harness.database, { id: 'task-1', title: 'Review the Northwind contract' }, CHAT_NOW)

    await harness.turn('What should I do with this?', undefined, { kind: 'task', id: 'task-1' })

    const system = harness.requests[0]?.system ?? ''
    expect(system).toContain('Review the Northwind contract')
    expect(system).toContain('“it”, “this” and “that” mean this one')
  })

  /** Criterion 9, the other half: nothing selected sends no item and the message still goes. */
  it('sends no item and still answers when nothing is selected', async () => {
    const harness = chatHarness({ answers: [textAnswer('Answered.')] })
    createTask(harness.database, { id: 'task-1', title: 'A very distinctive title' }, CHAT_NOW)

    const events = await harness.turn('What is in my inbox?')

    expect(streamedText(events)).toBe('Answered.')
    expect(harness.requests[0]?.system).not.toContain('A very distinctive title')
    expect(doneEvent(events).message.context).toBeNull()
  })

  /**
   * Criterion 10. An id is not what was sent: the record says which fields went, at which level, and
   * in what words, and those words are the ones the request carried.
   */
  it('records the resolved context, and it is what the request carried', async () => {
    const harness = chatHarness({ answers: [textAnswer('Answered.')] })
    createTask(harness.database, { id: 'task-1', title: 'Review the contract' }, CHAT_NOW)

    const done = doneEvent(
      await harness.turn('What is this?', undefined, { kind: 'task', id: 'task-1' }),
    )

    expect(done.message.context).toMatchObject({
      kind: 'task',
      id: 'task-1',
      found: true,
      contentLevel: 'snippet',
    })
    expect(done.message.context?.fields).toContain('title')
    // The one object read by three things, so the record cannot describe a request that was not made.
    expect(harness.requests[0]?.system).toContain(done.message.context?.rendered ?? 'nothing')
  })

  /** Criterion 11: per message, not per conversation. */
  it('records what each turn sent rather than sharing the first turn’s item', async () => {
    const harness = chatHarness({ answers: [textAnswer('One.'), textAnswer('Two.')] })
    createTask(harness.database, { id: 'task-1', title: 'The first one' }, CHAT_NOW)
    createTask(harness.database, { id: 'task-2', title: 'The second one' }, CHAT_NOW)

    const first = doneEvent(
      await harness.turn('About this one', undefined, { kind: 'task', id: 'task-1' }),
    )
    await harness.turn('And this one', first.conversation.id, { kind: 'task', id: 'task-2' })

    const turns = getTranscript(harness.database, first.conversation.id)?.messages ?? []
    const contexts = turns
      .filter((message) => message.role === 'assistant')
      .map((message) => message.context?.id)

    expect(contexts).toEqual(['task-1', 'task-2'])
    expect(harness.requests[1]?.system).toContain('The second one')
    expect(harness.requests[1]?.system).not.toContain('The first one')
  })

  /** And a turn sent with nothing selected after one that had an item does not inherit it. */
  it('does not carry an item over to a turn that was sent without one', async () => {
    const harness = chatHarness({ answers: [textAnswer('One.'), textAnswer('Two.')] })
    createTask(harness.database, { id: 'task-1', title: 'The first one' }, CHAT_NOW)

    const first = doneEvent(
      await harness.turn('About this one', undefined, { kind: 'task', id: 'task-1' }),
    )
    await harness.turn('And in general?', first.conversation.id)

    expect(harness.requests[1]?.system).not.toContain('The first one')
  })

  /** Criterion 12: an item deleted between selecting and sending is reported gone, not dropped. */
  it('tells the model an item that has gone is gone, and still answers', async () => {
    const harness = chatHarness({ answers: [textAnswer('That one is no longer there.')] })

    const events = await harness.turn('What about this?', undefined, {
      kind: 'task',
      id: 'deleted-task',
    })

    expect(harness.requests[0]?.system).toContain('no longer there')
    expect(streamedText(events)).toBe('That one is no longer there.')
    // The kind, the id and the sentence saying it is gone are what went, so they are what is recorded.
    expect(doneEvent(events).message.context).toMatchObject({
      found: false,
      fields: ['kind', 'id', 'note'],
    })
  })

  /** Criterion 13: a read-only turn was still sent, so it carries the context and records it. */
  it('carries and records the context on a read-only turn', async () => {
    const harness = chatHarness({
      answers: [textAnswer('Answered.')],
      supportsTools: false,
    })
    createTask(harness.database, { id: 'task-1', title: 'Review the contract' }, CHAT_NOW)

    const done = doneEvent(
      await harness.turn('What is this?', undefined, { kind: 'task', id: 'task-1' }),
    )

    expect(harness.requests[0]?.system).toContain('Review the contract')
    expect(done.message.context).toMatchObject({ id: 'task-1', found: true })
  })

  /**
   * Spec 09, criterion 13, asserted against the built request rather than against the template: the
   * whole point of the boundary is that it is checked where the bytes leave.
   */
  it('honours the content policy over the item’s notes', async () => {
    const harness = chatHarness({
      answers: [textAnswer('Answered.')],
      file: { privacy: { llmContent: 'metadata' } },
    })
    createTask(
      harness.database,
      { id: 'task-1', title: 'Review the contract', notes: 'Ring Ada about the indemnity clause.' },
      CHAT_NOW,
    )

    const done = doneEvent(
      await harness.turn('What is this?', undefined, { kind: 'task', id: 'task-1' }),
    )

    expect(harness.requests[0]?.system).toContain('Review the contract')
    expect(harness.requests[0]?.system).not.toContain('indemnity')
    expect(done.message.context?.contentLevel).toBe('metadata')
  })

  it('carries a selected project as readily as a task', async () => {
    const harness = chatHarness({ answers: [textAnswer('Answered.')] })
    const project = createProject(
      harness.database,
      { id: 'project-1', title: 'Northwind renewal' },
      CHAT_NOW,
    )

    await harness.turn('Where is this up to?', undefined, { kind: 'project', id: project.id })

    expect(harness.requests[0]?.system).toContain('Northwind renewal')
  })

  /**
   * Spec 09, criterion 13, on the path a refusal used to leave open. At `none` the context withholds
   * the title and `get_task` refuses it, and a model told that will ask another tool: a search's page
   * of summaries then carried the titles into the next request, which is the same disclosure by a
   * different door. Asserted on the tool result the request actually carried.
   */
  it('withholds the titles from a search at none, on the request the tool result went in', async () => {
    const harness = chatHarness({
      answers: [
        toolAnswer([{ name: 'search_tasks', arguments: {} }]),
        textAnswer('I cannot see what they are called.'),
      ],
      file: { privacy: { llmContent: 'none' } },
    })
    createTask(harness.database, { id: 'task-1', title: 'Review the Northwind contract' }, CHAT_NOW)

    await harness.turn('What is this?', undefined, { kind: 'task', id: 'task-1' })

    const result = toolResultText(harness.requests[1]?.messages.at(-1))
    expect(result).toContain('task-1')
    expect(result).not.toContain('Northwind')
    expect(result).toMatch(/content policy/i)
    expect(harness.requests[1]?.system).not.toContain('Northwind')
  })
})

/**
 * Spec 09, criterion 13, asserted where the criterion says it is: against the built request, for every
 * tool rather than for the three that had a request-level test. A tool result is serialised into the
 * next request of the same turn, so the request is the boundary and a direct `execute()` call is one
 * step short of it.
 */
describe('every tool at none, on the request its result went in', () => {
  const calls: readonly (readonly [string, unknown])[] = [
    ['search_tasks', {}],
    ['get_task', { id: 'task-1' }],
    ['list_projects', {}],
    ['get_daily_plan', {}],
    ['get_capacity', {}],
    ['list_waiting', {}],
    ['create_task', { title: 'What the user just asked for' }],
    ['update_task', { id: 'task-1', estimateMinutes: 45 }],
    ['complete_task', { id: 'task-1' }],
    ['mark_reviewed', { id: 'task-3' }],
    ['create_project', { title: 'What the user just named' }],
    ['update_project', { id: 'project-1', state: 'done' }],
  ]

  for (const [name, args] of calls) {
    it(`sends no item text back to the provider from ${name}`, async () => {
      const harness = chatHarness({
        answers: [
          toolAnswer([{ name, arguments: args }]),
          textAnswer('I cannot see what they are called.'),
        ],
        database: seedItemText(),
        file: { privacy: { llmContent: 'none' } },
      })

      await harness.turn('Deal with it')

      const result = toolResultText(harness.requests[1]?.messages.at(-1))
      expect(result).toMatch(/content policy/i)
      // The whole request, not only the tool result: the system prompt, the replayed turns and the
      // result travel together, and the policy governs the payload rather than one field of it.
      const request = JSON.stringify(harness.requests[1])
      for (const withheld of ITEM_TEXT) expect(request).not.toContain(withheld)
    })
  }

  /**
   * The failure this closes, in the words it happens in: at `none` the model is given an id and a
   * sentence saying the rest was withheld, the user says "mark it done", and the tool answered with
   * the title, the name of the person it waited on and its project.
   */
  it('completes the task without telling the model what it was called', async () => {
    const harness = chatHarness({
      answers: [
        toolAnswer([{ name: 'complete_task', arguments: { id: 'task-2' } }]),
        textAnswer('Done.'),
      ],
      database: seedItemText(),
      file: { privacy: { llmContent: 'none' } },
    })

    await harness.turn('Mark it done', undefined, { kind: 'task', id: 'task-2' })

    expect(getTask(harness.database, 'task-2')).toMatchObject({ status: 'done' })
    const result = toolResultText(harness.requests[1]?.messages.at(-1))
    expect(result).toContain('task-2')
    expect(result).not.toContain('Beatrix')
  })

  /**
   * The second door into the same disclosure: a delete is held for the user, and the refusal the model
   * is handed was built from `describe`, which reads the title out of the database. The user's own
   * confirmation card still names the task, which is asserted in `tools.test.ts`.
   */
  it('withholds the title from the refusal a held delete answers with', async () => {
    const harness = chatHarness({
      answers: [
        toolAnswer([{ name: 'delete_task', arguments: { id: 'task-1' } }]),
        textAnswer('I have proposed it.'),
      ],
      database: seedItemText(),
      file: { privacy: { llmContent: 'none' } },
    })

    const events = await harness.turn('Delete task-1')

    const result = toolResultText(harness.requests[1]?.messages.at(-1))
    expect(result).toContain('task-1')
    expect(result).not.toContain('Northwind')
    // The card the user decides on is built from the same call and still names what it would delete.
    expect(eventsOfType(events, 'confirmation')[0]?.confirmation.summary).toBe(
      'Delete “Review the Northwind contract”',
    )
  })
})

/**
 * Spec 09's rule that a level is a property of the boundary, applied to the transcript. A conversation
 * held at `snippet` and then lowered to `none` replayed its earlier turns verbatim, titles and note
 * excerpts included, which is the same stale artefact the day's plan summary is: `prompt.ts` withholds
 * that, and two stale artefacts must not get two answers.
 */
describe('the turns replayed as context', () => {
  it('replays the conversation while the policy allows an item’s text', async () => {
    const harness = chatHarness({
      answers: [textAnswer('It is in your inbox.'), textAnswer('Still there.')],
    })
    const first = doneEvent(await harness.turn('What about the Northwind contract?'))

    await harness.turn('And now?', first.conversation.id)

    expect(JSON.stringify(harness.requests[1]?.messages)).toContain('Northwind')
  })

  it('withholds them at none, and says it did rather than pretending the turn is the first', async () => {
    const harness = chatHarness({
      answers: [textAnswer('It is in your inbox.'), textAnswer('Ask me again.')],
      file: { privacy: { llmContent: 'none' } },
    })
    const first = doneEvent(await harness.turn('What about the Northwind contract?'))

    await harness.turn('And now?', first.conversation.id)

    expect(JSON.stringify(harness.requests[1]?.messages)).not.toContain('Northwind')
    expect(harness.requests[1]?.system).toMatch(/earlier turns/i)
    // The message just sent is the user's own words and still goes: withholding that would be a chat
    // that ignores you.
    expect(JSON.stringify(harness.requests[1]?.messages)).toContain('And now?')
  })
})

/**
 * One turn: the user says something, the model answers, and along the way it calls tools which
 * read and change Caroline's own data. Spec 07.
 *
 * The shape of it, and why:
 *
 * - The user's turn and an empty assistant turn are written before the model is asked anything, so
 *   that the changes and confirmations the turn produces have a turn to belong to and so a
 *   conversation whose connection dropped is still there to reopen. Spec 08, criterion 7.
 * - The loop runs to completion whether or not anybody is still listening. The events are how a
 *   browser watches it happen; the database is where it happened.
 * - The tool-call budget is counted over the whole turn, and a turn that runs out of it stops and
 *   says so, leaving what it already did done. Criterion 6.
 * - A delete is never executed, and neither is a write past the point where the turn has changed
 *   more tasks than the configured threshold. Both are written down as confirmations for the user
 *   to decide on. Criteria 3 and 4.
 */
import { withholdsItemText } from '../config/content.js'
import type { Config } from '../config/schema.js'
import type { Database } from '../db/connection.js'
import {
  appendMessage,
  contextMessages,
  createConversation,
  conversationTitle,
  finishMessage,
  getConversation,
  recordTurnContext,
  type ChatChangeRecord,
  type ChatConfirmationRecord,
  type ChatMessageRecord,
  type Conversation,
  type FinishMessageInput,
} from '../db/repositories/chat.js'
import { getUserName } from '../db/repositories/settings.js'
import type { LlmRuntime } from '../llm/index.js'
import { renderPreamble } from '../llm/prompts/preamble.js'
import {
  LlmError,
  type CompletionChunk,
  type Message,
  type ToolCall,
  type ToolResult,
} from '../llm/types.js'
import type { ItemRef } from '../domain/selection.js'
import type { ChangeFeed } from '../server/changes.js'
import { resolveItemContext } from './context.js'
import { argumentsProblem, executeTool } from './execute.js'
import { gateWrite, type GateAccumulator } from './gate.js'
import { buildChatContext, chatSystemPrompt } from './prompt.js'
import { buildToolRegistry, type ToolRegistry } from './registry.js'
import type { ChatToolContext, PlanRegeneration } from './types.js'

/** What a caller watches a turn through. Every event is also a row, except the text deltas. */
export type ChatEvent =
  /** Which conversation this turn belongs to, first, so a new one can be attached to at once. */
  | { readonly type: 'conversation'; readonly conversation: Conversation }
  | { readonly type: 'user-message'; readonly message: ChatMessageRecord }
  /** The turn the changes and confirmations below belong to, and the unit undo works in. */
  | { readonly type: 'turn'; readonly messageId: string; readonly readOnly: boolean }
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'tool'
      readonly name: string
      readonly outcome: 'ok' | 'refused' | 'held'
    }
  | { readonly type: 'change'; readonly change: ChatChangeRecord }
  | { readonly type: 'confirmation'; readonly confirmation: ChatConfirmationRecord }
  | {
      readonly type: 'done'
      readonly message: ChatMessageRecord
      readonly conversation: Conversation
    }
  /** The turn could not be completed. The transcript keeps whatever text did arrive. */
  | { readonly type: 'error'; readonly message: string }

export type ChatEmit = (event: ChatEvent) => void

export interface ChatTurnOptions {
  readonly database: Database
  readonly config: Config
  readonly llm: LlmRuntime
  readonly now: () => number
  readonly calendarConnected: () => boolean
  readonly regeneratePlan: () => Promise<PlanRegeneration>
  /** Told when a turn changed tasks or projects, so an open board reloads. Spec 08. */
  readonly changes?: ChangeFeed
}

export interface TurnInput {
  /** Omitted to start a new conversation, which is titled from this first message. */
  readonly conversationId?: string
  readonly message: string
  /**
   * The item the user had open when they sent this message, or omitted where nothing was. Per message
   * rather than per conversation, and never carried over from an earlier turn: an item you closed is
   * an item you stopped talking about. Spec 07.
   */
  readonly selected?: ItemRef
}

/** Why a turn could not start at all. Distinct from a turn that started and then failed. */
export type TurnRefusal = 'no-such-conversation'

export async function runTurn(
  options: ChatTurnOptions,
  input: TurnInput,
  emit: ChatEmit,
): Promise<TurnRefusal | null> {
  const { database, config, llm } = options
  const at = options.now()

  const conversation =
    input.conversationId === undefined
      ? createConversation(database, { title: conversationTitle(input.message) }, at)
      : getConversation(database, input.conversationId)

  if (conversation === null) return 'no-such-conversation'

  emit({ type: 'conversation', conversation })

  // Held onto rather than only emitted: at `none` it is the one message that goes, so `history` has to
  // be able to tell it from the turns before it.
  const asked = appendMessage(
    database,
    { conversationId: conversation.id, role: 'user', content: input.message },
    at,
  )
  emit({ type: 'user-message', message: asked })

  const turn = appendMessage(
    database,
    { conversationId: conversation.id, role: 'assistant', content: '' },
    at,
  )

  // Not configured is a plain answer rather than an error: the rest of Caroline works without a
  // model, and a conversation that says why it cannot help is more use than a failed request.
  if (!llm.isConfigured('chat')) {
    const message =
      'No language model is configured, so I cannot answer. Set llm.provider and its model, then try again.'
    emit({ type: 'text', text: message })
    finish(
      options,
      conversation.id,
      turn.id,
      {
        content: message,
        toolCalls: 0,
        toolCallLimitReached: false,
        readOnly: true,
        inputTokens: 0,
        outputTokens: 0,
        stopReason: null,
        error: 'chat is not configured',
      },
      emit,
    )
    return null
  }

  const provider = llm.for('chat')
  // Spec 03: Ollama tool support varies by model, so the configuration declares it. Without it
  // there is no tool to offer, and the turn says so rather than claiming changes. Criterion 7.
  const readOnly = !provider.supportsTools
  const registry = buildToolRegistry({ tools: !readOnly })

  emit({ type: 'turn', messageId: turn.id, readOnly })

  const toolContext: ChatToolContext = {
    database,
    config,
    now: at,
    calendarConnected: options.calendarConnected,
    regeneratePlan: options.regeneratePlan,
  }

  /**
   * The item that was open, resolved once and written down before the provider is asked anything.
   * One object, three readers: this request, the record below, and the payload preview. Spec 07.
   *
   * Recorded before the call rather than after it, so a turn the provider failed still says what had
   * already been resolved to send.
   */
  const itemContext =
    input.selected === undefined ? null : resolveItemContext({ database, config }, input.selected)

  if (itemContext !== null) {
    recordTurnContext(database, { messageId: turn.id, ...itemContext }, at)
  }

  const system = chatSystemPrompt(
    buildChatContext({ database, config, now: at, calendarConnected: options.calendarConnected }),
    {
      readOnly,
      bulkThreshold: config.chat.bulkConfirmThreshold,
      maxToolCalls: config.chat.maxToolCalls,
      // Read at the moment the turn is built, so a name changed in Settings takes effect on the
      // next turn rather than on the next restart. Spec 09.
      preamble: renderPreamble({ userName: getUserName(database) }),
      itemContext: itemContext?.rendered ?? null,
      // The same question `history` asks, so the prompt cannot say the turns were sent while they were
      // withheld. Spec 09, criterion 13.
      priorTurnsWithheld: withholdsItemText(config.privacy),
    },
  )

  const state: TurnState = {
    calls: 0,
    capped: false,
    mutatedTaskIds: new Set<string>(),
    bulkConfirmation: null,
    changed: false,
    inputTokens: 0,
    outputTokens: 0,
    stopReason: null,
    said: [],
  }

  let error: string | null = null

  try {
    await converse(
      options,
      toolContext,
      registry,
      system,
      { conversationId: conversation.id, turnId: turn.id, askedId: asked.id },
      state,
      emit,
    )
  } catch (failure) {
    // A provider that failed part-way is a fact about this turn, not about Caroline: the text that
    // did arrive is kept, and the row says what went wrong.
    error =
      failure instanceof LlmError || failure instanceof Error ? failure.message : String(failure)
    emit({ type: 'error', message: error })
  }

  if (state.capped) {
    state.said.push(
      `I stopped there: this turn reached its limit of ${config.chat.maxToolCalls} tool calls. Everything above is done. Tell me to carry on and I will pick up where I left off.`,
    )
  }

  if (state.changed) {
    // The board and the projects list are both derived from tasks, so both are announced, exactly
    // as the task routes do it.
    options.changes?.publish({ kind: 'tasks', at: options.now() })
    options.changes?.publish({ kind: 'projects', at: options.now() })
  }

  finish(
    options,
    conversation.id,
    turn.id,
    {
      content: state.said.join('\n\n'),
      toolCalls: state.calls,
      toolCallLimitReached: state.capped,
      readOnly,
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
      stopReason: state.stopReason,
      error,
    },
    emit,
  )

  return null
}

interface TurnState extends GateAccumulator {
  calls: number
  capped: boolean
  changed: boolean
  inputTokens: number
  outputTokens: number
  stopReason: string | null
  /** What the assistant said, in the order it said it. Joined into the stored turn. */
  readonly said: string[]
}

/** Which turn of which conversation is being run, and which message asked for it. */
interface TurnIdentity {
  readonly conversationId: string
  /** The empty assistant turn being filled in, which is never sent back as context. */
  readonly turnId: string
  /** The user message this turn answers. */
  readonly askedId: string
}

/** The model's side of the turn: ask, run what it asked for, ask again, until it stops. */
async function converse(
  options: ChatTurnOptions,
  toolContext: ChatToolContext,
  registry: ToolRegistry,
  system: string,
  identity: TurnIdentity,
  state: TurnState,
  emit: ChatEmit,
): Promise<void> {
  const { config, llm } = options
  const provider = llm.for('chat')
  // Rebuilt rather than appended to: a request carries the messages as they were when it was made,
  // and a caller holding one (the recording fake in the tests, or a future retry) must not find it
  // has grown a turn since.
  let messages: readonly Message[] = history(options, identity)

  for (;;) {
    /**
     * The budget is spent, so this turn gets one more pass in which to say what it did, and is told
     * in as many words not to reach for another tool. Criterion 6 asks that the turn end with a
     * message saying so, and the model's own account of what it managed is the better half of that.
     *
     * The tools stay declared even on this pass. Anthropic rejects a request whose messages carry
     * `tool_use` or `tool_result` blocks and no `tools` field, so withdrawing them here would turn a
     * capped turn into a failed one on that provider alone.
     */
    const budgetSpent = state.calls >= config.chat.maxToolCalls
    if (budgetSpent) {
      state.capped = true
      messages = [...messages, { role: 'user', content: capNotice(config.chat.maxToolCalls) }]
    }

    const completion = await drain(
      provider.stream({
        system,
        messages,
        ...(registry.tools.length === 0
          ? {}
          : {
              tools: registry.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              })),
            }),
        maxTokens: config.llm.maxTokens,
      }),
      emit,
    )

    state.inputTokens += completion.usage.inputTokens
    state.outputTokens += completion.usage.outputTokens
    state.stopReason = completion.stopReason
    if (completion.text !== '') state.said.push(completion.text)

    if (completion.toolCalls.length === 0) return

    // The turn was told its budget was spent. A call on this pass is the model asking anyway, and it
    // is not executed: the whole point of a cap is that it holds.
    if (budgetSpent) return

    const answered: ToolCall[] = []
    const results: ToolResult[] = []

    for (const call of completion.toolCalls) {
      if (state.calls >= config.chat.maxToolCalls) break
      state.calls += 1

      results.push(await handle(options, toolContext, registry, call, identity.turnId, state, emit))
      answered.push(call)
    }

    // Only the calls that were answered go back: a provider shown a call with no result beside it
    // would refuse the request. A call dropped at the cap is therefore left out of the record of
    // what the model said, which is the lesser inaccuracy of the two available.
    messages = [
      ...messages,
      { role: 'assistant', content: completion.text, toolCalls: answered },
      { role: 'user', content: '', toolResults: results },
    ]
  }
}

/** What the model is told when its budget runs out, in the turn where it may still answer. */
function capNotice(maxToolCalls: number): string {
  return `You have used all ${maxToolCalls} tool calls for this turn. Do not call another one: it will not be run. Say what you did and what is left, in one or two sentences.`
}

/** One tool call: validated, gated, and either run or written down for the user to confirm. */
async function handle(
  options: ChatTurnOptions,
  toolContext: ChatToolContext,
  registry: ToolRegistry,
  call: ToolCall,
  turnId: string,
  state: TurnState,
  emit: ChatEmit,
): Promise<ToolResult> {
  const tool = registry.get(call.name)
  if (tool === undefined) {
    emit({ type: 'tool', name: call.name, outcome: 'refused' })
    return refusal(
      call,
      `There is no tool called ${call.name}. Use one of the tools you were given.`,
    )
  }

  // Before the gate, not only before execution: an operation held for the user to confirm has to be
  // one that could actually run, or confirming it would fail on arguments nobody ever checked.
  const problem = argumentsProblem(tool, call.arguments)
  if (problem !== null) {
    emit({ type: 'tool', name: call.name, outcome: 'refused' })
    return refusal(call, problem)
  }

  if (tool.kind === 'write') {
    const held = hold(toolContext, tool, call, turnId, state, emit)
    if (held !== null) return held
  }

  const result = await executeTool(toolContext, tool, call.arguments, turnId)

  if (!result.ok) {
    emit({ type: 'tool', name: call.name, outcome: 'refused' })
    return refusal(call, result.message)
  }

  for (const change of result.changes) emit({ type: 'change', change })
  for (const taskId of result.taskIds) state.mutatedTaskIds.add(taskId)
  if (result.changes.length > 0) state.changed = true

  emit({ type: 'tool', name: call.name, outcome: 'ok' })

  return { toolCallId: call.id, name: call.name, content: JSON.stringify(result.data ?? {}) }
}

/**
 * The two gates, or null when neither applies. Both answer the model plainly: the operation was
 * not performed, the user has been asked, and that is not something to retry.
 *
 * The decision itself is `gateWrite` (`src/chat/gate.ts`), shared with the MCP session's own
 * calls (spec 07 criterion 14, spec 12): this function's job is only to translate that decision
 * into what a browser turn does with it, emitting the confirmation and the held outcome and
 * shaping the model's `ToolResult`.
 */
function hold(
  toolContext: ChatToolContext,
  tool: {
    readonly name: string
    readonly alwaysConfirm?: boolean
    readonly touchesTasks?: boolean
    describe?: (context: ChatToolContext, args: unknown) => string
  },
  call: ToolCall,
  turnId: string,
  state: TurnState,
  emit: ChatEmit,
): ToolResult | null {
  const outcome = gateWrite(toolContext, tool, { arguments: call.arguments }, turnId, state)
  if (!outcome.held) return null

  emit({ type: 'confirmation', confirmation: outcome.confirmation })
  emit({ type: 'tool', name: call.name, outcome: 'held' })

  return refusal(call, outcome.message, { retryable: false })
}

function refusal(
  call: ToolCall,
  message: string,
  { retryable = true }: { retryable?: boolean } = {},
): ToolResult {
  return {
    toolCallId: call.id,
    name: call.name,
    content: JSON.stringify(retryable ? { error: message } : { held: true, message }),
    isError: retryable,
  }
}

/** What a streamed answer came to. Text is emitted as it arrives and reassembled here. */
async function drain(
  stream: AsyncIterable<CompletionChunk>,
  emit: ChatEmit,
): Promise<{
  text: string
  toolCalls: readonly ToolCall[]
  usage: { inputTokens: number; outputTokens: number }
  stopReason: string
}> {
  let text = ''

  for await (const chunk of stream) {
    if (chunk.type === 'text') {
      text += chunk.text
      emit({ type: 'text', text: chunk.text })
      continue
    }

    // The final chunk carries the whole result, so the text is taken from it rather than from the
    // pieces: a provider whose deltas and whose final message disagree is not something to average.
    return {
      text: chunk.result.text === '' ? text : chunk.result.text,
      toolCalls: chunk.result.toolCalls,
      usage: chunk.result.usage,
      stopReason: chunk.result.stopReason,
    }
  }

  // A stream that ended without a final chunk answered nothing. Treated as a failed turn rather
  // than as an empty answer, because an empty answer is a claim that the model had nothing to say.
  throw new LlmError('The model stream ended without an answer.')
}

/**
 * The turns sent as context, oldest first, with anything that has no text left out.
 *
 * None of them at `none`. A stored turn is prose about the user's items, written and answered while the
 * policy allowed it, so replaying it verbatim would send titles and note excerpts the level in force now
 * withholds from every other path. It is the same stale artefact as a plan summary drawn before the
 * policy was lowered, which `prompt.ts` withholds, and two stale artefacts cannot get two answers. The
 * message the user just sent is their own words and still goes; the prompt says the rest was withheld,
 * so the model asks rather than answering from a conversation it cannot see. Spec 09, criterion 13.
 */
function history(
  options: ChatTurnOptions,
  { conversationId, turnId, askedId }: TurnIdentity,
): Message[] {
  const withheld = withholdsItemText(options.config.privacy)

  return contextMessages(options.database, conversationId, options.config.chat.contextMessages)
    .filter((message) => message.id !== turnId && message.content !== '')
    .filter((message) => !withheld || message.id === askedId)
    .map((message) => ({ role: message.role, content: message.content }))
}

function finish(
  options: ChatTurnOptions,
  conversationId: string,
  turnId: string,
  input: FinishMessageInput,
  emit: ChatEmit,
): void {
  const message = finishMessage(options.database, turnId, input, options.now())
  const conversation = getConversation(options.database, conversationId)

  // The conversation was read at the top of this turn and nothing deletes one, so its absence is a
  // bug rather than a case to render an empty transcript for.
  if (conversation === null) {
    throw new Error(`chat conversation ${conversationId} vanished during a turn`)
  }

  emit({ type: 'done', message, conversation })
}

/**
 * The chat surface's state: the conversation list, the transcript being read, and the turn in
 * flight. Kept out of `App.tsx` for the same reason `data.ts` is: the shell should not grow a
 * second job, and a streamed turn has enough moving parts to be worth reading on its own.
 *
 * The turn is the only place in the client where a response arrives in pieces. What arrives is
 * appended to a draft turn, and when the turn is done the stored message replaces the draft: the
 * server's record is the truth about what was said, and reassembling it here twice would be two
 * chances to differ.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  api,
  ApiFailure,
  type ChatChangeView,
  type ChatConfirmationView,
  type ChatMessageView,
  type ChatStatus,
  type ConversationView,
} from './api.js'

/** The turn being streamed: what has arrived so far, and what it has done. */
export interface DraftTurn {
  readonly messageId: string | null
  readonly text: string
  readonly readOnly: boolean
  readonly changes: readonly ChatChangeView[]
  readonly confirmations: readonly ChatConfirmationView[]
  /** The tools it has called this turn, in order, so the wait says what is happening. */
  readonly tools: readonly string[]
  readonly error: string | null
}

export interface ChatState {
  readonly status: ChatStatus | null
  readonly conversations: readonly ConversationView[]
  readonly conversation: ConversationView | null
  readonly messages: readonly ChatMessageView[]
  readonly draft: DraftTurn | null
  readonly sending: boolean
  readonly failure: string | null
  send: (message: string) => void
  confirm: (id: string, confirmed: boolean) => void
  undo: (messageId: string) => void
  /** Re-reads the conversation being shown, and the list. */
  refresh: () => Promise<void>
}

export interface UseChatOptions {
  /** The conversation the route is on, or null for a new one. */
  readonly conversationId: string | null
  /** Whether the surface is on screen. Nothing is fetched for a surface nobody is looking at. */
  readonly active: boolean
  /** Called when a turn changed tasks or projects, so the rest of the UI reloads. */
  readonly onDataChanged: () => void
  /** Where a new conversation's id goes, so the route follows the turn that created it. */
  readonly onConversationStarted: (id: string) => void
}

function describeFailure(error: unknown): string {
  if (error instanceof ApiFailure) return error.message
  if (error instanceof Error) return error.message
  return 'Something went wrong talking to the server'
}

const emptyDraft: DraftTurn = {
  messageId: null,
  text: '',
  readOnly: false,
  changes: [],
  confirmations: [],
  tools: [],
  error: null,
}

export function useChat({
  conversationId,
  active,
  onDataChanged,
  onConversationStarted,
}: UseChatOptions): ChatState {
  const [status, setStatus] = useState<ChatStatus | null>(null)
  const [conversations, setConversations] = useState<readonly ConversationView[]>([])
  const [conversation, setConversation] = useState<ConversationView | null>(null)
  const [messages, setMessages] = useState<readonly ChatMessageView[]>([])
  const [draft, setDraft] = useState<DraftTurn | null>(null)
  const [sending, setSending] = useState(false)
  /**
   * Two failures, because they go stale at different moments: a read failure is cleared by the next
   * successful read, and one from a turn or a confirmation is the user's to see until they do
   * something else. One piece of state would have the reload that follows an action quietly wipe the
   * reason it failed.
   */
  const [readFailure, setReadFailure] = useState<string | null>(null)
  const [actionFailure, setActionFailure] = useState<string | null>(null)

  /** Which conversation the current reads are for, so a slower one cannot overwrite a newer. */
  const generation = useRef(0)

  const refresh = useCallback(async () => {
    generation.current += 1
    const mine = generation.current

    try {
      const [list, transcript] = await Promise.all([
        api.listConversations(),
        conversationId === null ? Promise.resolve(null) : api.getConversation(conversationId),
      ])
      if (mine !== generation.current) return

      setConversations(list.conversations)
      setConversation(transcript?.conversation ?? null)
      setMessages(transcript?.messages ?? [])
      setReadFailure(null)
    } catch (error) {
      if (mine !== generation.current) return
      setReadFailure(describeFailure(error))
    }
  }, [conversationId])

  useEffect(() => {
    if (!active) return

    void refresh()
    void api
      .getChatStatus()
      .then(setStatus)
      .catch(() => setStatus(null))
  }, [active, refresh])

  const send = useCallback(
    (message: string) => {
      if (sending || message.trim() === '') return

      setSending(true)
      setActionFailure(null)
      setDraft(emptyDraft)

      let changed = false
      let startedConversation: string | null = null

      void api
        .streamChat(
          {
            ...(conversationId === null ? {} : { conversationId }),
            message,
          },
          (event) => {
            if (event.type === 'conversation') {
              setConversation(event.conversation)
              if (conversationId === null) startedConversation = event.conversation.id
              return
            }
            if (event.type === 'user-message') {
              setMessages((current) => [...current, event.message])
              return
            }
            if (event.type === 'turn') {
              setDraft((current) => ({
                ...(current ?? emptyDraft),
                messageId: event.messageId,
                readOnly: event.readOnly,
              }))
              return
            }
            if (event.type === 'text') {
              setDraft((current) => ({
                ...(current ?? emptyDraft),
                text: (current?.text ?? '') + event.text,
              }))
              return
            }
            if (event.type === 'tool') {
              setDraft((current) => ({
                ...(current ?? emptyDraft),
                tools: [...(current?.tools ?? []), event.name],
              }))
              return
            }
            if (event.type === 'change') {
              changed = true
              setDraft((current) => ({
                ...(current ?? emptyDraft),
                changes: [...(current?.changes ?? []), event.change],
              }))
              return
            }
            if (event.type === 'confirmation') {
              setDraft((current) => ({
                ...(current ?? emptyDraft),
                // A confirmation is updated as more of the turn is held, so it replaces the one
                // with its id rather than appearing twice.
                confirmations: [
                  ...(current?.confirmations ?? []).filter(
                    (existing) => existing.id !== event.confirmation.id,
                  ),
                  event.confirmation,
                ],
              }))
              return
            }
            if (event.type === 'error') {
              setDraft((current) => ({ ...(current ?? emptyDraft), error: event.message }))
              return
            }

            // Done. The stored turn replaces the draft, so what is on screen is what was recorded.
            setMessages((current) => [
              ...current.filter((existing) => existing.id !== event.message.id),
              event.message,
            ])
            setConversation(event.conversation)
            setDraft(null)
          },
        )
        .catch((error: unknown) => setActionFailure(describeFailure(error)))
        .finally(() => {
          setSending(false)
          if (changed) onDataChanged()
          // Last, so the route change does not restart the read while the turn is still arriving.
          if (startedConversation !== null) onConversationStarted(startedConversation)
          void refresh()
        })
    },
    [conversationId, onConversationStarted, onDataChanged, refresh, sending],
  )

  const confirm = useCallback(
    (id: string, confirmed: boolean) => {
      void api
        .confirmChat(id, confirmed)
        .then((result) => {
          setActionFailure(result.failures.length === 0 ? null : result.failures.join('; '))
          if (result.changes.length > 0) onDataChanged()
        })
        .catch((error: unknown) => setActionFailure(describeFailure(error)))
        .finally(() => void refresh())
    },
    [onDataChanged, refresh],
  )

  const undo = useCallback(
    (messageId: string) => {
      if (conversationId === null) return

      void api
        .undoChatTurn(conversationId, messageId)
        .then(() => {
          setActionFailure(null)
          onDataChanged()
        })
        .catch((error: unknown) => setActionFailure(describeFailure(error)))
        .finally(() => void refresh())
    },
    [conversationId, onDataChanged, refresh],
  )

  return {
    status,
    conversations,
    conversation,
    messages,
    draft,
    sending,
    // The newer of the two: an action the user just took is what they are waiting to hear about.
    failure: actionFailure ?? readFailure,
    send,
    confirm,
    undo,
    refresh,
  }
}

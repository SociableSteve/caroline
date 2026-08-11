/**
 * The chat surface. Spec 08: transcript, streamed responses, inline records of what changed with
 * undo, and confirmation prompts for deletes and bulk operations.
 *
 * The three things worth saying out loud are all said out loud here rather than implied: that chat
 * is read-only when the model cannot use tools, that a turn stopped because it ran out of tool
 * calls rather than because it had finished, and how many items a confirmation would affect.
 */
import { useState } from 'react'
import type {
  ChatChangeView,
  ChatConfirmationView,
  ChatMessageView,
  ChatStatus,
  ConversationView,
} from '../api.js'
import type { DraftTurn } from '../chat.js'
import { ago } from '../format.js'
import { conversationHref } from '../router.js'
import { Field } from '../components/primitives.js'
import { useSurfaceTitle } from '../title.js'

export interface ChatProps {
  readonly status: ChatStatus | null
  readonly conversations: readonly ConversationView[]
  readonly conversation: ConversationView | null
  readonly messages: readonly ChatMessageView[]
  readonly draft: DraftTurn | null
  readonly sending: boolean
  readonly failure: string | null
  readonly now: number
  readonly onSend: (message: string) => void
  readonly onConfirm: (id: string, confirmed: boolean) => void
  readonly onUndo: (messageId: string) => void
}

/**
 * Which turn may be undone: the last one that changed something that has not been put back. Spec
 * 07 offers undo for the last mutation batch, and an older batch's inverse holds values from before
 * whatever happened after it.
 */
function undoableTurnId(messages: readonly ChatMessageView[]): string | null {
  const undoable = messages.filter((message) =>
    message.changes.some((change) => change.undoable && change.undoneAt === null),
  )

  return undoable.at(-1)?.id ?? null
}

function ChangeRecord({ change }: { readonly change: ChatChangeView }) {
  return (
    <li className={change.undoneAt === null ? undefined : 'change-undone'}>
      <span className="change-summary">{change.summary}</span>{' '}
      {change.undoneAt === null ? null : <span className="change-note">undone</span>}
    </li>
  )
}

function Confirmation({
  confirmation,
  onConfirm,
}: {
  readonly confirmation: ChatConfirmationView
  readonly onConfirm: (id: string, confirmed: boolean) => void
}) {
  const decided = confirmation.decidedAt !== null

  return (
    <div className="chat-confirmation" role="group" aria-label="Confirmation needed">
      <p>
        <strong>{confirmation.reason === 'delete' ? 'Delete' : 'Bulk change'}:</strong>{' '}
        {confirmation.summary}
      </p>
      <p className="change-note">
        {confirmation.affectedCount} {confirmation.affectedCount === 1 ? 'item' : 'items'} affected.
        Nothing has happened yet.
      </p>

      {decided ? (
        <p className="change-note">
          {confirmation.decision === 'confirmed' ? 'Confirmed and applied.' : 'Discarded.'}
        </p>
      ) : (
        <>
          <button type="button" onClick={() => onConfirm(confirmation.id, true)}>
            Confirm
          </button>{' '}
          <button type="button" onClick={() => onConfirm(confirmation.id, false)}>
            Discard
          </button>
        </>
      )}
    </div>
  )
}

function Turn({
  message,
  undoable,
  onConfirm,
  onUndo,
}: {
  readonly message: ChatMessageView
  readonly undoable: boolean
  readonly onConfirm: (id: string, confirmed: boolean) => void
  readonly onUndo: (messageId: string) => void
}) {
  return (
    <li className={`chat-turn chat-${message.role}`}>
      <p className="chat-role">{message.role === 'user' ? 'You' : 'Caroline'}</p>
      {message.content === '' ? (
        <p className="empty">Nothing was said.</p>
      ) : (
        message.content.split('\n\n').map((paragraph, index) => (
          <p key={index} className="chat-text">
            {paragraph}
          </p>
        ))
      )}

      {message.changes.length > 0 && (
        <div className="chat-changes">
          <ul>
            {message.changes.map((change) => (
              <ChangeRecord key={change.id} change={change} />
            ))}
          </ul>
          {undoable && (
            <button
              type="button"
              aria-label="Undo the changes this turn made"
              onClick={() => onUndo(message.id)}
            >
              Undo
            </button>
          )}
        </div>
      )}

      {message.confirmations.map((confirmation) => (
        <Confirmation key={confirmation.id} confirmation={confirmation} onConfirm={onConfirm} />
      ))}

      {/* Spec 07, criterion 6: a turn that ran out of tool calls says so, and what it did stands. */}
      {message.toolCallLimitReached && (
        <p role="status" className="chat-note">
          This turn reached its tool-call limit. The changes above were made; ask it to carry on for
          the rest.
        </p>
      )}

      {message.error !== null && (
        <p role="alert" className="failure">
          {message.error}
        </p>
      )}
    </li>
  )
}

export function Chat({
  status,
  conversations,
  conversation,
  messages,
  draft,
  sending,
  failure,
  now,
  onSend,
  onConfirm,
  onUndo,
}: ChatProps) {
  const [typed, setTyped] = useState('')
  const undoable = undoableTurnId(messages)
  useSurfaceTitle('Chat')

  const submit = () => {
    const message = typed.trim()
    if (message === '' || sending) return

    onSend(message)
    setTyped('')
  }

  return (
    <div className="chat-surface">
      <h1 className="chat-title">Chat</h1>

      <aside aria-labelledby="conversations-heading">
        <h2 id="conversations-heading">Conversations</h2>
        <p>
          <a href="#/chat">New conversation</a>
        </p>

        {conversations.length === 0 ? (
          <p className="empty">Nothing yet.</p>
        ) : (
          <ul className="conversation-list">
            {conversations.map((entry) => (
              <li key={entry.id}>
                <a
                  href={conversationHref(entry.id)}
                  aria-current={entry.id === conversation?.id ? 'page' : undefined}
                >
                  {entry.title}
                </a>
                <span className="change-note"> {ago(entry.updatedAt, now)}</span>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <section aria-labelledby="chat-heading">
        <h2 id="chat-heading">{conversation === null ? 'New conversation' : conversation.title}</h2>

        {/* Criterion 7: said plainly, before anything is typed, rather than discovered afterwards. */}
        {status !== null && status.readOnly && (
          <p role="status" className="chat-readonly">
            {status.configured
              ? `Read-only: ${status.model ?? 'the configured model'} cannot use tools, so chat can answer questions but cannot change anything.`
              : 'Read-only: no language model is configured, so chat cannot answer or change anything yet.'}
          </p>
        )}

        {failure !== null && (
          <p role="alert" className="failure">
            {failure}
          </p>
        )}

        {messages.length === 0 && draft === null ? (
          <p className="empty">
            Ask about the inbox, a project, or what today looks like. Changes you ask for happen at
            once and can be undone.
          </p>
        ) : (
          <ul className="chat-transcript">
            {messages.map((message) => (
              <Turn
                key={message.id}
                message={message}
                undoable={message.id === undoable}
                onConfirm={onConfirm}
                onUndo={onUndo}
              />
            ))}

            {/* Deliberately not a live region as a whole: a screen reader would read the answer
                again from the top on every chunk that arrived. The progress line below is live
                instead, and the finished turn is read in the ordinary way. */}
            {draft !== null && (
              <li className="chat-turn chat-assistant">
                <p className="chat-role">Caroline</p>
                {draft.text === '' ? (
                  <p className="chat-text">Thinking.</p>
                ) : (
                  draft.text.split('\n\n').map((paragraph, index) => (
                    <p key={index} className="chat-text">
                      {paragraph}
                    </p>
                  ))
                )}

                {draft.tools.length > 0 && (
                  <p className="change-note" role="status">
                    Looked at: {draft.tools.join(', ')}
                  </p>
                )}

                {draft.changes.length > 0 && (
                  <div className="chat-changes">
                    <ul>
                      {draft.changes.map((change) => (
                        <ChangeRecord key={change.id} change={change} />
                      ))}
                    </ul>
                  </div>
                )}

                {draft.confirmations.map((confirmation) => (
                  <Confirmation
                    key={confirmation.id}
                    confirmation={confirmation}
                    onConfirm={onConfirm}
                  />
                ))}

                {draft.error !== null && (
                  <p role="alert" className="failure">
                    {draft.error}
                  </p>
                )}
              </li>
            )}
          </ul>
        )}

        <form
          className="chat-composer"
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
        >
          <Field label="Message">
            <textarea
              rows={3}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              onKeyDown={(event) => {
                // Enter sends, as in every chat; shift and enter is a new line.
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  submit()
                }
              }}
            />
          </Field>
          <button type="submit" disabled={sending || typed.trim() === ''}>
            {sending ? 'Answering' : 'Send'}
          </button>
        </form>

        {conversation !== null && (
          <p className="change-note">
            {conversation.inputTokens + conversation.outputTokens} tokens in this conversation (
            {conversation.inputTokens} in, {conversation.outputTokens} out).
          </p>
        )}
      </section>
    </div>
  )
}

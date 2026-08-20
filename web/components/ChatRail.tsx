/**
 * The chat rail. Spec 08: chat is not one of the surfaces, it is a companion beside whichever
 * surface you are on, because asking about the board while the board is on screen is the whole point
 * and a route swap takes the board away to do it.
 *
 * What that changes about the old surface: the rail does not own an `h1` (the surface it sits beside
 * does), the conversation list is behind a disclosure rather than a column of its own, and it can be
 * closed. Below the width where a rail leaves the surface usable it becomes an overlay above it,
 * which is a stylesheet rule rather than a second component.
 *
 * The three things worth saying out loud are still said out loud here rather than implied: that chat
 * is read-only when the model cannot use tools, that a turn stopped because it ran out of tool calls
 * rather than because it had finished, and how many items a confirmation would affect.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '../lib/utils.js'
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
import {
  changeNoteClassName,
  emptyClassName,
  Field,
  failureClassName,
  payloadPreviewClassName,
} from './primitives.js'
import { Button } from './ui/button.js'
import { Textarea } from './ui/textarea.js'

export interface ChatRailProps {
  /**
   * The details of the item that is open, above the conversation. One rail rather than two: a details
   * column beside a chat column leaves the board scrolled sideways more or less permanently, and
   * stacking them does the work a label would otherwise have to do. Null where nothing is open.
   * Spec 08.
   */
  readonly details?: ReactNode
  readonly status: ChatStatus | null
  readonly conversations: readonly ConversationView[]
  readonly conversation: ConversationView | null
  readonly messages: readonly ChatMessageView[]
  readonly draft: DraftTurn | null
  readonly sending: boolean
  readonly failure: string | null
  readonly now: number
  /** The hash the conversation links are built from, so opening one keeps the surface. */
  readonly hash: string
  readonly onSend: (message: string) => void
  readonly onConfirm: (id: string, confirmed: boolean) => void
  readonly onUndo: (messageId: string) => void
  readonly onClose: () => void
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
  const undone = change.undoneAt !== null
  return (
    <li>
      <span className={undone ? 'text-muted-foreground line-through' : undefined}>
        {change.summary}
      </span>{' '}
      {undone && <span className={changeNoteClassName}>undone</span>}
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
    <div
      className="mt-2 rounded-md border border-destructive bg-destructive/5 px-3 py-2 text-xs"
      role="group"
      aria-label="Confirmation needed"
    >
      <p className="m-0 mb-2">
        <strong>{confirmation.reason === 'delete' ? 'Delete' : 'Bulk change'}:</strong>{' '}
        {confirmation.summary}
      </p>
      <p className={changeNoteClassName}>
        {confirmation.affectedCount} {confirmation.affectedCount === 1 ? 'item' : 'items'} affected.
        Nothing has happened yet.
      </p>

      {decided ? (
        <p className={changeNoteClassName}>
          {confirmation.decision === 'confirmed' ? 'Confirmed and applied.' : 'Discarded.'}
        </p>
      ) : (
        <div className="action-row flex flex-wrap items-end gap-1.5">
          <Button
            type="button"
            variant="default"
            size="xs"
            className="px-2.5"
            onClick={() => onConfirm(confirmation.id, true)}
          >
            Confirm
          </Button>
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="px-2.5 text-muted-foreground"
            onClick={() => onConfirm(confirmation.id, false)}
          >
            Discard
          </Button>
        </div>
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
    <li
      className={cn(
        'rounded-xl bg-card p-2.5 text-xs leading-relaxed shadow-sm',
        message.role === 'user' && 'bg-secondary shadow-none',
      )}
    >
      <p className="m-0 mb-1 font-mono text-[9px] uppercase tracking-[0.05em] text-muted-foreground">
        {message.role === 'user' ? 'You' : 'Caroline'}
      </p>
      {message.content === '' ? (
        <p className={emptyClassName}>Nothing was said.</p>
      ) : (
        message.content.split('\n\n').map((paragraph, index) => (
          <p key={index} className="m-0 mb-2 whitespace-pre-wrap">
            {paragraph}
          </p>
        ))
      )}

      {message.changes.length > 0 && (
        <div className="mt-2 border-l-2 border-chart-2/50 py-1 pl-3">
          <ul className="mb-2 pl-4 text-sm">
            {message.changes.map((change) => (
              <ChangeRecord key={change.id} change={change} />
            ))}
          </ul>
          {undoable && (
            <Button
              type="button"
              size="xs"
              className="px-2.5"
              aria-label="Undo the changes this turn made"
              onClick={() => onUndo(message.id)}
            >
              Undo
            </Button>
          )}
        </div>
      )}

      {message.confirmations.map((confirmation) => (
        <Confirmation key={confirmation.id} confirmation={confirmation} onConfirm={onConfirm} />
      ))}

      {/* What this turn sent about the item that was open. Recorded so the conversation can be
          audited, and shown here because an audit nobody can read is a table. Spec 07, criterion 10.

          Loosely compared on purpose: the server always sends the field, null included, but a turn
          rendered from a payload that happened not to carry it must not blank the page. That is the
          class of defect the SSE contract fix removed, and one guard is cheaper than another. */}
      {message.context != null && (
        <details>
          <summary className="cursor-pointer text-sm text-muted-foreground">
            What was sent about the open {message.context.kind}
          </summary>
          <p className={changeNoteClassName}>
            {message.context.found
              ? `Fields sent: ${message.context.fields.join(', ')}.`
              : 'It had gone by the time this was sent, and the model was told so.'}{' '}
            Content level {message.context.contentLevel}, policy {message.context.policyVersion}.
          </p>
          <pre className={payloadPreviewClassName}>{message.context.rendered}</pre>
        </details>
      )}

      {/* Spec 07, criterion 6: a turn that ran out of tool calls says so, and what it did stands. */}
      {message.toolCallLimitReached && (
        <p role="status" className="max-w-[76ch] rounded-md bg-muted px-3 py-2 text-sm">
          This turn reached its tool-call limit. The changes above were made; ask it to carry on for
          the rest.
        </p>
      )}

      {message.error !== null && (
        <p role="alert" className={failureClassName}>
          {message.error}
        </p>
      )}
    </li>
  )
}

export function ChatRail({
  details = null,
  status,
  conversations,
  conversation,
  messages,
  draft,
  sending,
  failure,
  now,
  hash,
  onSend,
  onConfirm,
  onUndo,
  onClose,
}: ChatRailProps) {
  const [typed, setTyped] = useState('')
  const undoable = undoableTurnId(messages)
  const scrollRef = useRef<HTMLDivElement>(null)
  // Whether the log should follow new content. Starts true (a rail that opens mid-conversation
  // opens at the bottom, not wherever the browser happened to land), goes false the moment the
  // user scrolls up to read something earlier, and comes back true once they scroll back down to
  // the bottom themselves, never on its own: reading an old message while an answer streams in
  // would otherwise be interrupted by the log yanking itself back down.
  const stickToBottom = useRef(true)

  const onScroll = () => {
    const el = scrollRef.current
    if (el === null) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    stickToBottom.current = distanceFromBottom < 16
  }

  // A message arriving, a draft growing by one chunk and a confirmation appearing are all reasons
  // to follow, so the dependency list covers everything that changes the transcript's rendered
  // height or content. Deliberately not `typed`, which lives in this same component: a keystroke
  // in the composer changes that state on every character and must not force a scroll
  // recomputation.
  useEffect(() => {
    if (!stickToBottom.current) return
    const el = scrollRef.current
    if (el === null) return
    el.scrollTop = el.scrollHeight
  }, [messages, draft, failure, status, conversation, conversations])

  const submit = () => {
    const message = typed.trim()
    if (message === '' || sending) return

    // Sending is what a scrolled-up reader does to rejoin, not something that happens to them:
    // it puts the log back at the bottom for the message just sent and the answer coming in,
    // the same as opening the rail on a conversation already in progress does.
    stickToBottom.current = true
    onSend(message)
    setTyped('')
  }

  return (
    <aside
      className="flex h-full flex-col gap-3 self-stretch overflow-hidden border-l border-sidebar-border bg-sidebar p-4"
      aria-label="Chat"
    >
      {details}

      <div className="flex shrink-0 items-baseline justify-between gap-2">
        <h2 className="m-0 text-xs font-semibold">
          {conversation === null ? 'New conversation' : conversation.title}
        </h2>
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="whitespace-nowrap text-muted-foreground"
          onClick={onClose}
        >
          Close chat
        </Button>
      </div>

      {/* A disclosure rather than a column: a rail is not wide enough for two, and the list is read
          when an earlier conversation is wanted rather than while one is being had. */}
      <details className="shrink-0">
        <summary className="cursor-pointer text-sm text-muted-foreground">Conversations</summary>
        <p>
          {/* No conversation rather than the rail closed: the rail is open by default, so a hash
              naming none is the rail open on one nobody has started yet. */}
          <a href={conversationHref(null, hash)}>New conversation</a>
        </p>

        {conversations.length === 0 ? (
          <p className={emptyClassName}>Nothing yet.</p>
        ) : (
          <ul className="m-0 p-0 [list-style:none]">
            {conversations.map((entry) => (
              <li key={entry.id} className="border-b border-border py-1 text-sm">
                <a
                  href={conversationHref(entry.id, hash)}
                  aria-current={entry.id === conversation?.id ? 'page' : undefined}
                >
                  {entry.title}
                </a>
                <span className={changeNoteClassName}> {ago(entry.updatedAt, now)}</span>
              </li>
            ))}
          </ul>
        )}
      </details>

      {/* Criterion 7: said plainly, before anything is typed, rather than discovered afterwards. */}
      {status !== null && status.readOnly && (
        <p role="status" className="max-w-[76ch] shrink-0 rounded-md bg-muted px-3 py-2 text-xs">
          {status.configured
            ? `Read-only: ${status.model ?? 'the configured model'} cannot use tools, so chat can answer questions but cannot change anything.`
            : 'Read-only: no language model is configured, so chat cannot answer or change anything yet.'}
        </p>
      )}

      {failure !== null && (
        <p role="alert" className={cn(failureClassName, 'shrink-0')}>
          {failure}
        </p>
      )}

      {/* The one scrolling region in the rail: everything above stays put, and this follows the
          bottom on its own until the user scrolls up out of it. */}
      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
        {messages.length === 0 && draft === null ? (
          <p className={emptyClassName}>
            Ask about the inbox, a project, or what today looks like. Changes you ask for happen at
            once and can be undone.
          </p>
        ) : (
          <ul className="m-0 flex max-w-[76ch] flex-col gap-3 p-0 [list-style:none]">
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
              <li className="rounded-xl bg-card p-2.5 text-xs leading-relaxed shadow-sm">
                <p className="m-0 mb-1 font-mono text-[9px] uppercase tracking-[0.05em] text-muted-foreground">
                  Caroline
                </p>
                {draft.text === '' ? (
                  <p className="m-0 mb-2 whitespace-pre-wrap">Thinking.</p>
                ) : (
                  draft.text.split('\n\n').map((paragraph, index) => (
                    <p key={index} className="m-0 mb-2 whitespace-pre-wrap">
                      {paragraph}
                    </p>
                  ))
                )}

                {draft.tools.length > 0 && (
                  <p className={changeNoteClassName} role="status">
                    Looked at: {draft.tools.join(', ')}
                  </p>
                )}

                {draft.changes.length > 0 && (
                  <div className="mt-2 border-l-2 border-chart-2/50 py-1 pl-3">
                    <ul className="pl-4 text-sm">
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
                  <p role="alert" className={failureClassName}>
                    {draft.error}
                  </p>
                )}
              </li>
            )}
          </ul>
        )}
      </div>

      <form
        className="flex max-w-[76ch] shrink-0 flex-col gap-1.5"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <Field label="Message">
          <Textarea
            rows={2}
            className="resize-none text-xs"
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
        <div className="flex justify-end">
          <Button
            type="submit"
            variant="default"
            size="sm"
            className="h-7 px-3 text-xs"
            disabled={sending || typed.trim() === ''}
          >
            {sending ? 'Answering' : 'Send'}
          </Button>
        </div>
      </form>

      {conversation !== null && (
        <p className={cn(changeNoteClassName, 'shrink-0')}>
          {conversation.inputTokens + conversation.outputTokens} tokens in this conversation (
          {conversation.inputTokens} in, {conversation.outputTokens} out).
        </p>
      )}
    </aside>
  )
}

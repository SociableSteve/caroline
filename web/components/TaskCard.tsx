/**
 * One card. Everything that matters about a task is on it: nothing is behind a hover, per
 * spec 08, and every state that is carried by colour is also carried by text.
 */
import { useState, type KeyboardEvent } from 'react'
import { boardStatuses, type ItemRef, type TaskStatus, type TaskView } from '../api.js'
import { ActionRow, Badge, Fact, Facts, Field } from './primitives.js'
import {
  canMarkReviewed,
  formatAge,
  formatConfidence,
  formatDate,
  formatDue,
  formatEstimate,
  hasOptedOutOfSync,
  hasPushedSinceReview,
  isCompletionProposed,
  isDeferred,
  isStale,
  pullRequestSource,
  statusLabel,
  suppressedSources,
  waitingAge,
} from '../format.js'

export interface TaskCardProps {
  readonly task: TaskView
  readonly projectTitle?: string | undefined
  readonly staleDays: number
  readonly now: number
  readonly onStatusChange: (id: string, status: TaskStatus) => void
  readonly onComplete: (id: string) => void
  readonly onDelete: (id: string) => void
  /** Absent on surfaces that do not offer the action, such as a project drill-in. */
  readonly onMarkReviewed?: ((id: string) => void) | undefined
  /** The one-click accept spec 04 asks for. Absent where a proposal cannot be acted on. */
  readonly onAcceptProposal?: ((id: string) => void) | undefined
  readonly onDismissProposal?: ((id: string) => void) | undefined
  /** Putting the last status change back. Absent where the surface does not offer it. */
  readonly onUndoStatus?: ((id: string) => void) | undefined
  /**
   * Opens this task in the rail's details region, which is also what sends it to the model as context.
   * Absent on a surface that does not offer it. Spec 08: it is on the title rather than in the action
   * row, which is already at the width a column can afford.
   */
  readonly onSelect?: ((item: ItemRef) => void) | undefined
  /** Whether this is the task the rail is showing, so the card says which one is open. */
  readonly selected?: boolean | undefined
  /** The board hands this in to drive its own keyboard grid. */
  readonly onKeyDown?: ((event: KeyboardEvent<HTMLElement>) => void) | undefined
  readonly registerRef?: ((id: string, element: HTMLElement | null) => void) | undefined
}

export function TaskCard({
  task,
  projectTitle,
  staleDays,
  now,
  onStatusChange,
  onComplete,
  onDelete,
  onMarkReviewed,
  onAcceptProposal,
  onDismissProposal,
  onUndoStatus,
  onSelect,
  selected = false,
  onKeyDown,
  registerRef,
}: TaskCardProps) {
  // Deleting is one click away but never one click: the card asks, in place, rather than
  // through a browser dialog that a keyboard user has to leave the board to answer.
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const waiting = task.status === 'waiting'
  const stale = waiting && isStale(task, now, staleDays)
  const pullRequest = pullRequestSource(task)
  // Notifications about this work that produced no task of their own. On the card because
  // suppressing a duplicate must not mean it silently vanished. Spec 02.
  const suppressed = suppressedSources(task)
  const pushedSince = waiting && hasPushedSinceReview(task)
  const optedOut = hasOptedOutOfSync(task)
  const completionProposed = isCompletionProposed(task)
  // The primary action on a Review card, because it is the one taken most often. Spec 08.
  const offerMarkReviewed = onMarkReviewed !== undefined && canMarkReviewed(task)
  // A proposal the classifier was not confident enough to apply. Shown with its reasoning and its
  // confidence, because accepting somebody else's guess unseen is not triage. Spec 04.
  const proposal = onAcceptProposal === undefined ? null : task.proposal

  return (
    <li className="card-slot">
      <article
        className={`card${stale ? ' card-stale' : ''}${selected ? ' card-open' : ''}`}
        aria-label={task.title}
        tabIndex={0}
        draggable
        ref={(element) => registerRef?.(task.id, element)}
        onKeyDown={onKeyDown}
        onDragStart={(event) => {
          event.dataTransfer.setData('text/plain', task.id)
          event.dataTransfer.effectAllowed = 'move'
        }}
      >
        {/* The title is the control that opens the task in the rail, so the thing being pointed at is
            the thing that responds, and the action row keeps the width it has. It stays a heading, so
            the outline is unchanged. Spec 08, criterion 27. */}
        <h3 className="card-title">
          {onSelect === undefined ? (
            task.title
          ) : (
            <button
              type="button"
              className="item-open"
              aria-pressed={selected}
              onClick={() => onSelect({ kind: 'task', id: task.id })}
            >
              {task.title}
            </button>
          )}
        </h3>

        {/* A card does not restate its own status: the column it is in says it, and so does the
            status control. A third telling is noise, and on an Inbox, Someday or Reference card it
            was the whole of the fact list. Spec 08, criterion 14. */}
        <Facts>
          {projectTitle !== undefined && <Fact label="Project">{projectTitle}</Fact>}

          {task.estimateMinutes !== null && (
            <Fact label="Estimate">{formatEstimate(task.estimateMinutes)}</Fact>
          )}

          {task.dueAt !== null && <Fact label="Due">{formatDue(task.dueAt, now)}</Fact>}

          {isDeferred(task, now) && task.deferUntil !== null && (
            <Fact label="Deferred until">{formatDate(task.deferUntil)}</Fact>
          )}

          {waiting && (
            <>
              <Fact label="Waiting on">{task.waitingOn ?? 'nobody named'}</Fact>
              <Fact label="Waiting for">
                {formatAge(waitingAge(task, now))}
                {stale && (
                  <>
                    {' '}
                    <Badge tone="alarm">Stale</Badge>
                  </>
                )}
              </Fact>
            </>
          )}

          {pullRequest !== undefined && pullRequest.url !== null && (
            <Fact label="From">
              <a href={pullRequest.url} target="_blank" rel="noreferrer">
                {pullRequest.externalId}
              </a>
            </Fact>
          )}

          {suppressed.length > 0 && (
            <Fact label="Also notified">
              {suppressed.map((source, index) => (
                <span key={source.id}>
                  {index > 0 && ', '}
                  {source.url === null ? (
                    (source.title ?? source.externalId)
                  ) : (
                    <a href={source.url} target="_blank" rel="noreferrer">
                      {source.title ?? source.externalId}
                    </a>
                  )}
                </span>
              ))}
            </Fact>
          )}

          {task.tags.length > 0 && <Fact label="Tags">{task.tags.join(', ')}</Fact>}
        </Facts>

        {/* Every state carried by a badge is carried by its words too, so none of it depends
            on colour alone. Spec 08, accessibility. */}
        {(pushedSince || optedOut || completionProposed) && (
          <ul className="card-flags">
            {pushedSince && (
              <li>
                <Badge tone="accent">The author has pushed since you reviewed</Badge>
              </li>
            )}
            {completionProposed && (
              <li>
                <Badge tone="accent">Closed upstream. Complete it?</Badge>
              </li>
            )}
            {optedOut && (
              <li>
                <Badge>Sync tracking off</Badge>
              </li>
            )}
          </ul>
        )}

        {proposal !== null && (
          <section className="card-proposal" aria-label={`Suggestion for ${task.title}`}>
            <p className="proposal-headline">
              Caroline suggests <strong>{statusLabel(proposal.status)}</strong>
              {proposal.status === 'waiting' && proposal.waitingOn !== null && (
                <span>, waiting on {proposal.waitingOn}</span>
              )}
              {/* Said as a number as well as a word: "not confident" is the reason it is a
                  suggestion rather than a decision, and how unconfident is the useful part. */}
              <span className="proposal-confidence">
                {' '}
                ({formatConfidence(proposal.confidence)} confident)
              </span>
            </p>

            {proposal.reasoning !== null && <p className="proposal-reason">{proposal.reasoning}</p>}

            {proposal.suggestedTitle !== null && (
              <p className="proposal-retitle">Would retitle it “{proposal.suggestedTitle}”</p>
            )}

            {proposal.projectSuggestion?.newProjectTitle != null && (
              <p className="proposal-project">
                Thinks this belongs to a project called “
                {proposal.projectSuggestion.newProjectTitle}
                ”. Creating one is your call.
              </p>
            )}

            <ActionRow>
              <button type="button" className="primary" onClick={() => onAcceptProposal?.(task.id)}>
                Accept
              </button>
              <button type="button" onClick={() => onDismissProposal?.(task.id)}>
                Dismiss
              </button>
            </ActionRow>
          </section>
        )}

        {/*
         * The primary action stays on the card. Spec 08's "nothing is hidden behind a hover" is a
         * rule about information, and every fact above is still visible; the rest of the controls
         * go behind this disclosure, which is visible, labelled and keyboard reachable. Three
         * controls abreast do not fit a column, and a card whose controls are taller than its
         * content has the emphasis backwards. Criteria 14 and 15.
         */}
        <ActionRow className="card-actions">
          {offerMarkReviewed && (
            <button type="button" className="primary" onClick={() => onMarkReviewed?.(task.id)}>
              Mark reviewed
            </button>
          )}

          <button type="button" onClick={() => onComplete(task.id)}>
            Complete
          </button>
        </ActionRow>

        <details className="card-more">
          {/*
           * The summary takes the board's own key handler. Without it the disclosure would be a
           * dead end for the keyboard: the board reads its shortcuts from the card and ignores
           * anything raised inside it, which is right for the select and the buttons but wrong
           * for a summary, where a digit or a `d` is still a board command and not typing.
           * Criterion 15.
           */}
          <summary onKeyDown={onKeyDown}>More</summary>

          <ActionRow className="card-actions">
            <Field label={`Status of ${task.title}`} hiddenLabel>
              <select
                value={task.status}
                onChange={(event) => onStatusChange(task.id, event.target.value as TaskStatus)}
              >
                {boardStatuses.map((status) => (
                  <option key={status} value={status}>
                    {statusLabel(status)}
                  </option>
                ))}
              </select>
            </Field>

            {/* Undoing restores the previous actor as well as the previous status, which is the
                part that matters: a board move locks the classifier out for good. Spec 08. */}
            {onUndoStatus !== undefined && task.previousStatus !== null && (
              <button type="button" onClick={() => onUndoStatus(task.id)}>
                Undo move
              </button>
            )}

            {confirmingDelete ? (
              <>
                <button type="button" onClick={() => onDelete(task.id)}>
                  Confirm delete
                </button>
                <button type="button" onClick={() => setConfirmingDelete(false)}>
                  Keep
                </button>
              </>
            ) : (
              <button type="button" onClick={() => setConfirmingDelete(true)}>
                Delete
              </button>
            )}
          </ActionRow>
        </details>
      </article>
    </li>
  )
}

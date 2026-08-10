/**
 * One card. Everything that matters about a task is on it: nothing is behind a hover, per
 * spec 08, and every state that is carried by colour is also carried by text.
 */
import { useState, type KeyboardEvent } from 'react'
import { boardStatuses, type TaskStatus, type TaskView } from '../api.js'
import {
  canMarkReviewed,
  formatAge,
  formatConfidence,
  formatDate,
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
        className={`card${stale ? ' card-stale' : ''}`}
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
        <h3 className="card-title">{task.title}</h3>

        <dl className="card-facts">
          <dt>Status</dt>
          <dd>{statusLabel(task.status)}</dd>

          {projectTitle !== undefined && (
            <>
              <dt>Project</dt>
              <dd>{projectTitle}</dd>
            </>
          )}

          {task.estimateMinutes !== null && (
            <>
              <dt>Estimate</dt>
              <dd>{formatEstimate(task.estimateMinutes)}</dd>
            </>
          )}

          {task.dueAt !== null && (
            <>
              <dt>Due</dt>
              <dd>{formatDate(task.dueAt)}</dd>
            </>
          )}

          {isDeferred(task, now) && task.deferUntil !== null && (
            <>
              <dt>Deferred until</dt>
              <dd>{formatDate(task.deferUntil)}</dd>
            </>
          )}

          {waiting && (
            <>
              <dt>Waiting on</dt>
              <dd>{task.waitingOn ?? 'nobody named'}</dd>
              <dt>Waiting for</dt>
              <dd>
                {formatAge(waitingAge(task, now))}
                {stale && <span className="badge badge-stale"> Stale</span>}
              </dd>
            </>
          )}

          {pullRequest !== undefined && pullRequest.url !== null && (
            <>
              <dt>From</dt>
              <dd>
                <a href={pullRequest.url} target="_blank" rel="noreferrer">
                  {pullRequest.externalId}
                </a>
              </dd>
            </>
          )}

          {suppressed.length > 0 && (
            <>
              <dt>Also notified</dt>
              <dd>
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
              </dd>
            </>
          )}

          {task.tags.length > 0 && (
            <>
              <dt>Tags</dt>
              <dd>{task.tags.join(', ')}</dd>
            </>
          )}
        </dl>

        {/* Every state carried by a badge is carried by its words too, so none of it depends
            on colour alone. Spec 08, accessibility. */}
        {(pushedSince || optedOut || completionProposed) && (
          <ul className="card-flags">
            {pushedSince && (
              <li className="badge badge-pushed">The author has pushed since you reviewed</li>
            )}
            {completionProposed && (
              <li className="badge badge-proposed">Closed upstream. Complete it?</li>
            )}
            {optedOut && <li className="badge badge-untracked">Sync tracking off</li>}
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

            <div className="proposal-actions">
              <button
                type="button"
                className="card-primary"
                onClick={() => onAcceptProposal?.(task.id)}
              >
                Accept
              </button>
              <button type="button" onClick={() => onDismissProposal?.(task.id)}>
                Dismiss
              </button>
            </div>
          </section>
        )}

        <div className="card-actions">
          {offerMarkReviewed && (
            <button
              type="button"
              className="card-primary"
              onClick={() => onMarkReviewed?.(task.id)}
            >
              Mark reviewed
            </button>
          )}

          <label className="card-status">
            <span className="visually-hidden">Status of {task.title}</span>
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
          </label>

          <button type="button" onClick={() => onComplete(task.id)}>
            Complete
          </button>

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
        </div>
      </article>
    </li>
  )
}

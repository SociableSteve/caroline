/**
 * One card. Everything that matters about a task is on it: nothing is behind a hover, per
 * spec 08, and every state that is carried by colour is also carried by text.
 */
import { useEffect, useState, type KeyboardEvent } from 'react'
import {
  boardStatuses,
  type ItemRef,
  type TaskInput,
  type TaskStatus,
  type TaskView,
} from '../api.js'
import { cn } from '../lib/utils.js'
import { ActionRow, Badge, Fact, Facts, Field, itemOpenClassName } from './primitives.js'
import { Button } from './ui/button.js'
import { Input } from './ui/input.js'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select.js'
import {
  canMarkReviewed,
  dateInputValue,
  deferUntilFromDateInput,
  dueAtFromDateInput,
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
  /** The zone `dueAtFromDateInput` and `deferUntilFromDateInput` resolve a typed date in, so a
   *  date set here lands on the same instant it would from chat. Spec 06. */
  readonly timezone: string
  /** Whether `timezone` is the deployment's real configured zone yet, rather than the UTC
   *  default it starts as while `GET /api/config` is still out. The board can already be
   *  interactive at that point, since `loading` only gates on the task reload; without this,
   *  a date set in that window would be silently resolved against UTC instead of the real zone.
   *  The due and defer-until fields are disabled until this is true. */
  readonly configLoaded: boolean
  readonly now: number
  readonly onStatusChange: (id: string, status: TaskStatus) => void
  readonly onComplete: (id: string) => void
  readonly onDelete: (id: string) => void
  /**
   * Setting, changing or clearing the due date or the defer-until date, from the card's "More"
   * disclosure. Either field is `null` to clear it and absent to leave it alone, the same
   * three-state contract `update_task` offers from chat.
   */
  readonly onDatesChange: (
    id: string,
    patch: Partial<Pick<TaskInput, 'dueAt' | 'deferUntil'>>,
  ) => void
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
  timezone,
  configLoaded,
  now,
  onStatusChange,
  onComplete,
  onDelete,
  onDatesChange,
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

  /**
   * The due and defer-until inputs are buffered locally and only committed on blur, the same
   * convention `QuickCapture` already uses for its own date fields. A native `<input
   * type="date">` can report `.value === ''` for an instant while an already-filled control is
   * mid-edit (clearing the year to retype it, for instance), and committing straight from
   * `onChange` the way an earlier draft of this card did would send that transient empty
   * reading on to the server as an unintended clear. Buffering means every keystroke is safe to
   * see, and only the value standing when the field loses focus is ever sent.
   */
  const dueAtValue = task.dueAt === null ? '' : dateInputValue(task.dueAt, timezone)
  const deferUntilValue = task.deferUntil === null ? '' : dateInputValue(task.deferUntil, timezone)
  const [dueDateInput, setDueDateInput] = useState(dueAtValue)
  const [deferDateInput, setDeferDateInput] = useState(deferUntilValue)

  useEffect(() => setDueDateInput(dueAtValue), [dueAtValue])
  useEffect(() => setDeferDateInput(deferUntilValue), [deferUntilValue])

  const commitDueDate = () => {
    if (dueDateInput === dueAtValue) return
    if (dueDateInput === '') {
      onDatesChange(task.id, { dueAt: null })
      return
    }
    // Null here means the value could not be resolved in `timezone` at all, which real IANA
    // zones do not do for a whole calendar day: left alone rather than guessed at.
    const resolved = dueAtFromDateInput(dueDateInput, timezone)
    if (resolved === null) return
    onDatesChange(task.id, { dueAt: resolved })
  }

  const commitDeferDate = () => {
    if (deferDateInput === deferUntilValue) return
    if (deferDateInput === '') {
      onDatesChange(task.id, { deferUntil: null })
      return
    }
    const resolved = deferUntilFromDateInput(deferDateInput, timezone)
    if (resolved === null) return
    onDatesChange(task.id, { deferUntil: resolved })
  }

  return (
    <li>
      <article
        className={cn(
          'card block cursor-grab rounded-md border border-border bg-card p-2',
          stale && 'card-stale border-destructive/40',
          selected && 'card-open border-chart-2/50',
        )}
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
        <h3 className="m-0 mb-1 text-xs font-medium leading-snug">
          {onSelect === undefined ? (
            task.title
          ) : (
            <button
              type="button"
              className={itemOpenClassName}
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
          <ul className="m-0 mb-2 flex flex-wrap gap-1 p-0 [list-style:none]">
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
          <section
            className="mb-2 rounded-sm border border-dashed border-ring p-2 text-sm"
            aria-label={`Suggestion for ${task.title}`}
          >
            <p className="m-0 mb-1">
              Caroline suggests <strong>{statusLabel(proposal.status)}</strong>
              {proposal.status === 'waiting' && proposal.waitingOn !== null && (
                <span>, waiting on {proposal.waitingOn}</span>
              )}
              {/* Said as a number as well as a word: "not confident" is the reason it is a
                  suggestion rather than a decision, and how unconfident is the useful part. */}
              <span className="text-muted-foreground">
                {' '}
                ({formatConfidence(proposal.confidence)} confident)
              </span>
            </p>

            {proposal.reasoning !== null && (
              <p className="m-0 mb-1 text-muted-foreground">{proposal.reasoning}</p>
            )}

            {proposal.suggestedTitle !== null && (
              <p className="m-0 mb-1 text-muted-foreground">
                Would retitle it “{proposal.suggestedTitle}”
              </p>
            )}

            {proposal.projectSuggestion?.newProjectTitle != null && (
              <p className="m-0 mb-1 text-muted-foreground">
                Thinks this belongs to a project called “
                {proposal.projectSuggestion.newProjectTitle}
                ”. Creating one is your call.
              </p>
            )}

            <ActionRow>
              <Button
                type="button"
                variant="default"
                size="xs"
                onClick={() => onAcceptProposal?.(task.id)}
              >
                Accept
              </Button>
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="text-muted-foreground"
                onClick={() => onDismissProposal?.(task.id)}
              >
                Dismiss
              </Button>
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
        <ActionRow className="text-sm">
          {offerMarkReviewed && (
            <Button
              type="button"
              variant="default"
              size="xs"
              onClick={() => onMarkReviewed?.(task.id)}
            >
              Mark reviewed
            </Button>
          )}

          <Button
            type="button"
            variant="outline"
            size="xs"
            className="text-muted-foreground"
            onClick={() => onComplete(task.id)}
          >
            Complete
          </Button>
        </ActionRow>

        <details className="mt-2">
          {/*
           * The summary takes the board's own key handler. Without it the disclosure would be a
           * dead end for the keyboard: the board reads its shortcuts from the card and ignores
           * anything raised inside it, which is right for the select and the buttons but wrong
           * for a summary, where a digit or a `d` is still a board command and not typing.
           * Criterion 15.
           */}
          <summary className="cursor-pointer text-sm text-muted-foreground" onKeyDown={onKeyDown}>
            More
          </summary>

          <ActionRow className="mt-2 text-sm">
            <Field label={`Status of ${task.title}`} hiddenLabel>
              <Select
                value={task.status}
                onValueChange={(value) => onStatusChange(task.id, value as TaskStatus)}
              >
                <SelectTrigger size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {boardStatuses.map((status) => (
                    <SelectItem key={status} value={status}>
                      {statusLabel(status)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            {/* Undoing restores the previous actor as well as the previous status, which is the
                part that matters: a board move locks the classifier out for good. Spec 08. */}
            {onUndoStatus !== undefined && task.previousStatus !== null && (
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="text-muted-foreground"
                onClick={() => onUndoStatus(task.id)}
              >
                Undo move
              </Button>
            )}
          </ActionRow>

          {/*
           * A visible label above each date input, rather than `hiddenLabel`: `Field`'s own
           * docstring reserves the hidden form for a control whose purpose the surrounding text
           * already gives, such as a card's status column, and a bare date picker has no such
           * context. A sighted user was seeing two unlabelled date pickers here before this fix.
           */}
          <div className="mt-2 flex flex-wrap gap-2">
            {/* A native date input, empty for unset. Clearing it back to empty sends `null`
                rather than leaving the field alone, so taking a date off a task is as direct as
                setting one. Issue #44.

                Typed and buffered locally rather than written on every `onChange`: a native date
                input can read as empty for an instant mid-edit (retyping the year of an
                already-set date, for instance), and committing that transient reading would
                clear the date under the person typing it. Committed on blur instead, the same
                convention `QuickCapture`'s own date fields use. */}
            <Field label="Due">
              <Input
                type="date"
                name="dueAt"
                value={dueDateInput}
                onChange={(event) => setDueDateInput(event.target.value)}
                onBlur={commitDueDate}
                disabled={!configLoaded}
                title={
                  configLoaded
                    ? undefined
                    : 'Waiting for the deployment’s configured timezone to load'
                }
              />
            </Field>

            <Field label="Defer until">
              <Input
                type="date"
                name="deferUntil"
                value={deferDateInput}
                onChange={(event) => setDeferDateInput(event.target.value)}
                onBlur={commitDeferDate}
                disabled={!configLoaded}
                title={
                  configLoaded
                    ? undefined
                    : 'Waiting for the deployment’s configured timezone to load'
                }
              />
            </Field>
          </div>

          <ActionRow className="mt-2 text-sm">
            {confirmingDelete ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  className="text-muted-foreground"
                  onClick={() => onDelete(task.id)}
                >
                  Confirm delete
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  className="text-muted-foreground"
                  onClick={() => setConfirmingDelete(false)}
                >
                  Keep
                </Button>
              </>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="text-muted-foreground"
                onClick={() => setConfirmingDelete(true)}
              >
                Delete
              </Button>
            )}
          </ActionRow>
        </details>
      </article>
    </li>
  )
}

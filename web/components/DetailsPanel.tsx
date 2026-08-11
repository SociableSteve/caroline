/**
 * The details of the item that is open, at the top of the rail, above the conversation. Spec 08.
 *
 * A reading surface rather than a second place to act: the card and the project row keep the
 * controls, because a control in two places is two places to keep in step. What this adds is
 * everything a card has no room for, and the fact that whatever is here is what the next message
 * sends to the model as context.
 *
 * It shows one of two kinds, tasks and projects, because those are the two things spec 07's tools
 * address and so the two things a conversation can be about. An item that has gone since it was
 * opened says so, rather than falling back to another.
 */
import type { ItemRef, ProjectView, TaskView } from '../api.js'
import {
  ago,
  formatAge,
  formatDate,
  formatDue,
  formatEstimate,
  hasOptedOutOfSync,
  hasPushedSinceReview,
  isDeferred,
  isStale,
  statusLabel,
  suppressedSources,
  waitingAge,
} from '../format.js'
import { Badge, Fact, Facts } from './primitives.js'

/** What the panel was able to find for the reference in the hash. */
export type DetailsSubject =
  | {
      readonly kind: 'task'
      readonly task: TaskView
      readonly projectTitle: string | null
    }
  | {
      readonly kind: 'project'
      readonly project: ProjectView
      /** Its tasks, for the counts. Nothing here lists them: the surfaces do that better. */
      readonly tasks: readonly TaskView[]
      /**
       * False where the client holds only a subset of the tasks, which it does on a large enough
       * inbox. A count taken from a subset and presented as the project's total is a wrong number
       * rather than a partial one, so the panel says which it is.
       */
      readonly allTasksLoaded: boolean
    }

export interface DetailsPanelProps {
  readonly item: ItemRef
  /** Null where the reference names nothing that is loaded. Spec 08, criterion 29. */
  readonly subject: DetailsSubject | null
  readonly staleDays: number
  readonly now: number
  readonly onClose: () => void
}

export function DetailsPanel({ item, subject, staleDays, now, onClose }: DetailsPanelProps) {
  const heading =
    subject === null
      ? 'Not here any more'
      : subject.kind === 'task'
        ? subject.task.title
        : subject.project.title

  return (
    <section className="rail-details" aria-label={`Details of ${heading}`}>
      <div className="rail-head">
        <h2 className="rail-heading">{heading}</h2>
        <button type="button" onClick={onClose}>
          Close details
        </button>
      </div>

      {subject === null ? (
        // Said rather than shown as a blank: the reference is well formed and the row is gone, which
        // is a different thing from nothing being selected.
        <p role="status" className="empty">
          This {item.kind} is not among the ones loaded here. It may have been completed or deleted.
        </p>
      ) : subject.kind === 'task' ? (
        <TaskDetails
          task={subject.task}
          projectTitle={subject.projectTitle}
          staleDays={staleDays}
          now={now}
        />
      ) : (
        <ProjectDetails
          project={subject.project}
          tasks={subject.tasks}
          allTasksLoaded={subject.allTasksLoaded}
        />
      )}

      {/* Why the panel is more than a bigger card: what is in it is what the next message sends. */}
      <p className="policy-note">
        Whatever is open here goes to the model with your next message, as far as the content policy
        allows.
      </p>
    </section>
  )
}

function TaskDetails({
  task,
  projectTitle,
  staleDays,
  now,
}: {
  readonly task: TaskView
  readonly projectTitle: string | null
  readonly staleDays: number
  readonly now: number
}) {
  const waiting = task.status === 'waiting'
  const stale = waiting && isStale(task, now, staleDays)
  const suppressed = suppressedSources(task)

  return (
    <>
      <Facts>
        {/* The panel is not a column, so unlike a card it does say the status: nothing around it
            does. Spec 08's criterion 14 is a rule about the board's cards. */}
        <Fact label="Status">{statusLabel(task.status)}</Fact>
        <Fact label="Set by">{task.statusSetBy === 'user' ? 'you' : task.statusSetBy}</Fact>
        {projectTitle !== null && <Fact label="Project">{projectTitle}</Fact>}
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
        {task.tags.length > 0 && <Fact label="Tags">{task.tags.join(', ')}</Fact>}
        <Fact label="Captured">{ago(task.createdAt, now)}</Fact>
        <Fact label="Last changed">{ago(task.updatedAt, now)}</Fact>
        {task.completedAt !== null && <Fact label="Completed">{ago(task.completedAt, now)}</Fact>}
      </Facts>

      {/* Every state a colour marks is also said in words. Spec 10. */}
      {(hasPushedSinceReview(task) || hasOptedOutOfSync(task)) && (
        <ul className="card-flags">
          {hasPushedSinceReview(task) && (
            <li>
              <Badge tone="accent">The author has pushed since you reviewed</Badge>
            </li>
          )}
          {hasOptedOutOfSync(task) && (
            <li>
              <Badge>Sync tracking off</Badge>
            </li>
          )}
        </ul>
      )}

      {task.notes !== null && task.notes !== '' && (
        <div className="details-notes">
          <h3 className="details-subheading">Notes</h3>
          <p>{task.notes}</p>
        </div>
      )}

      {/* Provenance, which spec 08 asks every task to show: where it came from, with a link out. */}
      {task.sources.length > 0 && (
        <div className="details-sources">
          <h3 className="details-subheading">Where it came from</h3>
          <ul>
            {task.sources.map((source) => (
              <li key={source.id}>
                {source.url === null ? (
                  (source.title ?? source.externalId)
                ) : (
                  <a href={source.url} target="_blank" rel="noreferrer">
                    {source.title ?? source.externalId}
                  </a>
                )}{' '}
                <span className="change-note">
                  {source.provider}
                  {suppressed.some((other) => other.id === source.id)
                    ? ', a notification kept as provenance'
                    : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {task.proposal !== null && (
        <p className="policy-note">
          Caroline suggests {statusLabel(task.proposal.status)} for this. Accept or dismiss it on
          the card.
        </p>
      )}
    </>
  )
}

function ProjectDetails({
  project,
  tasks,
  allTasksLoaded,
}: {
  readonly project: ProjectView
  readonly tasks: readonly TaskView[]
  readonly allTasksLoaded: boolean
}) {
  const open = tasks.filter((task) => task.status !== 'done')
  const done = tasks.length - open.length

  return (
    <>
      <Facts>
        <Fact label="State">{project.state}</Fact>
        <Fact label="Next action">
          {project.nextAction === null ? (
            <>
              none
              {project.stalled && (
                <>
                  {' '}
                  <Badge tone="alarm">Stalled</Badge>
                </>
              )}
            </>
          ) : (
            project.nextAction.title
          )}
        </Fact>
        {/* Counted from the tasks the client holds. Where that is a subset, the count is a floor and
            says so: the board already admits it is showing part of the list, and a panel beside it
            quoting a total it cannot know would contradict that. */}
        <Fact label="Tasks">
          {allTasksLoaded
            ? `${open.length} open, ${done} done`
            : `at least ${open.length} open and ${done} done, of the tasks loaded here`}
        </Fact>
      </Facts>

      {project.notes !== null && project.notes !== '' && (
        <div className="details-notes">
          <h3 className="details-subheading">Notes</h3>
          <p>{project.notes}</p>
        </div>
      )}
    </>
  )
}

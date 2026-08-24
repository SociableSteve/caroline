/**
 * The board: one column per status, drag between them to set a status, and the same moves available
 * from the keyboard through the controls on the cards themselves. Spec 08 criteria 3, 8 and 56: the
 * board keeps no keyboard grid of its own, so there is nothing here between a key and the control it
 * was pressed on.
 */
import { type DragEvent } from 'react'
import {
  boardStatuses,
  movableStatuses,
  type ItemRef,
  type ProjectView,
  type TaskInput,
  type TaskStatus,
  type TaskView,
} from '../api.js'
import { byOldestFirst, statusLabel } from '../format.js'
import { TaskCard } from '../components/TaskCard.js'
import { emptyClassName, Panel } from '../components/primitives.js'
import { useSurfaceTitle } from '../title.js'

export interface BoardProps {
  readonly tasks: readonly TaskView[]
  readonly projects: readonly ProjectView[]
  readonly staleDays: number
  /** The zone a due or defer-until date typed into a card resolves in. Spec 06. */
  readonly timezone: string
  /** Whether `timezone` is the deployment's real configured zone yet, rather than the UTC
   *  default it starts as. A card disables its date fields until this is true, so a date cannot
   *  be set and silently resolved against the wrong zone in the gap before the config read
   *  answers. */
  readonly configLoaded: boolean
  readonly now: number
  readonly onStatusChange: (id: string, status: TaskStatus) => void
  /** Naming the task that has to finish first, or `null` to clear it. Spec 08, criterion 52. */
  readonly onBlockerChange: (id: string, blockedBy: string | null) => void
  readonly onComplete: (id: string) => void
  readonly onDelete: (id: string) => void
  readonly onDatesChange: (
    id: string,
    patch: Partial<Pick<TaskInput, 'dueAt' | 'deferUntil'>>,
  ) => void
  readonly onMarkReviewed: (id: string) => void
  readonly onAcceptProposal: (id: string) => void
  readonly onDismissProposal: (id: string) => void
  /** Puts the last status change back, the actor with it. Spec 08, criteria 16 and 17. */
  readonly onUndoStatus: (id: string) => void
  /** Opens a task in the rail's details region. Spec 08, criterion 27. */
  readonly onSelect: (item: ItemRef) => void
  /** Which item the rail is showing, so the card that is open says so. */
  readonly selected: ItemRef | null
}

/** Whether a card may be moved into this column at all. Spec 08, criterion 53. */
function isMovableInto(status: TaskStatus): boolean {
  return movableStatuses.includes(status)
}

function group(tasks: readonly TaskView[]): Map<TaskStatus, TaskView[]> {
  const grouped = new Map<TaskStatus, TaskView[]>(boardStatuses.map((status) => [status, []]))

  for (const task of tasks) {
    grouped.get(task.status)?.push(task)
  }

  // The Waiting column is a chase list, and a chase list is read from the top, so the
  // longest wait is the first thing on it. Spec 08.
  grouped.get('waiting')?.sort(byOldestFirst)

  return grouped
}

export function Board({
  tasks,
  projects,
  staleDays,
  timezone,
  configLoaded,
  now,
  onStatusChange,
  onBlockerChange,
  onComplete,
  onDelete,
  onDatesChange,
  onMarkReviewed,
  onAcceptProposal,
  onDismissProposal,
  onUndoStatus,
  onSelect,
  selected,
}: BoardProps) {
  useSurfaceTitle('Board')
  const grouped = group(tasks)
  const columns = boardStatuses.map((status) => grouped.get(status) ?? [])
  const projectTitles = new Map(projects.map((project) => [project.id, project.title]))
  const taskTitles = new Map(tasks.map((task) => [task.id, task.title]))
  /**
   * What a card may be blocked behind: everything that could still finish. Completed work is
   * dropped rather than assumed absent, because `tasks` carries it even though `columns` does not,
   * and nothing would ever release a task filed behind something already done. The card drops
   * itself from the list, and a chain that comes back round is the server's to refuse. Spec 08,
   * criteria 52 and 54.
   */
  const blockerOptions = tasks
    .filter((task) => task.status !== 'done')
    .map((task) => ({ id: task.id, title: task.title }))

  const onDrop = (event: DragEvent<HTMLElement>, status: TaskStatus) => {
    event.preventDefault()
    // The second of two: Blocked is given no drop handler at all below, so this is only reached
    // if that changes. Cheap, and the rule is one a later hand should not be able to lose.
    if (!isMovableInto(status)) return

    const id = event.dataTransfer.getData('text/plain')
    if (id !== '') onStatusChange(id, status)
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-5">
      <h1 className="shrink-0">Board</h1>

      {/* No list role over the columns. Each is a region with an accessible name, which is
          already navigable; wrapping them in list semantics replaces that and costs the headings
          their place in the outline. Spec 08, accessibility. */}
      {/* Seven columns side by side need more room than six did: at the `md` breakpoint they came
          to about 100px each, which is narrower than a card's own content. The switch to a fitted
          row is at `lg` instead, and below it the board scrolls sideways at a readable 15rem per
          column, which is the behaviour spec 08 prescribes rather than a fallback. */}
      <div className="grid min-h-0 flex-1 auto-cols-[minmax(15rem,1fr)] grid-flow-col items-stretch gap-3 overflow-x-auto pb-2 lg:grid-flow-row lg:grid-cols-7 lg:overflow-x-visible">
        {boardStatuses.map((status, columnIndex) => {
          const column = columns[columnIndex] ?? []

          return (
            <Panel
              key={status}
              className="flex h-full min-h-24 flex-col overflow-hidden"
              headingClassName="m-0 mb-2 flex items-center gap-2 text-sm text-muted-foreground"
              headingLevel={2}
              label={`${statusLabel(status)}, ${column.length} ${
                column.length === 1 ? 'task' : 'tasks'
              }`}
              heading={
                <>
                  {/* No number beside the name any more: it was there to say which digit filed a
                      card into this column, and there are no digits. Spec 08, criterion 56. */}
                  {statusLabel(status)}
                  <span className="ml-auto rounded-full border border-border px-2 font-mono text-xs text-muted-foreground [font-variant-numeric:tabular-nums]">
                    {column.length}
                  </span>
                </>
              }
              // Blocked is not a drop target at all, so the pointer says so rather than the drop
              // being accepted and then quietly doing nothing. Spec 08, criterion 53.
              {...(isMovableInto(status)
                ? {
                    onDragOver: (event: DragEvent<HTMLElement>) => event.preventDefault(),
                    onDrop: (event: DragEvent<HTMLElement>) => onDrop(event, status),
                  }
                : {})}
            >
              {column.length === 0 ? (
                <p className={emptyClassName}>Nothing here.</p>
              ) : (
                <ul className="m-0 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-0 [list-style:none]">
                  {column.map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      {...(task.projectId !== null && projectTitles.has(task.projectId)
                        ? { projectTitle: projectTitles.get(task.projectId) }
                        : {})}
                      {...(task.blockedBy !== null && taskTitles.has(task.blockedBy)
                        ? { blockerTitle: taskTitles.get(task.blockedBy) }
                        : {})}
                      blockerOptions={blockerOptions}
                      onBlockerChange={onBlockerChange}
                      staleDays={staleDays}
                      timezone={timezone}
                      configLoaded={configLoaded}
                      now={now}
                      onStatusChange={onStatusChange}
                      onComplete={onComplete}
                      onDelete={onDelete}
                      onDatesChange={onDatesChange}
                      onMarkReviewed={onMarkReviewed}
                      onAcceptProposal={onAcceptProposal}
                      onDismissProposal={onDismissProposal}
                      onUndoStatus={onUndoStatus}
                      onSelect={onSelect}
                      selected={selected?.kind === 'task' && selected.id === task.id}
                    />
                  ))}
                </ul>
              )}
            </Panel>
          )
        })}
      </div>
    </div>
  )
}

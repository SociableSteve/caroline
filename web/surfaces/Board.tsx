/**
 * The board: one column per status, drag between them to set a status, and the same moves
 * available from the keyboard alone. Spec 08 criteria 3 and 8.
 */
import { useEffect, useRef, type DragEvent, type KeyboardEvent } from 'react'
import {
  boardStatuses,
  type ItemRef,
  type ProjectView,
  type TaskStatus,
  type TaskView,
} from '../api.js'
import { byOldestFirst, canMarkReviewed, statusLabel } from '../format.js'
import { TaskCard } from '../components/TaskCard.js'
import { Fact, Facts, Panel } from '../components/primitives.js'
import { useSurfaceTitle } from '../title.js'

export interface BoardProps {
  readonly tasks: readonly TaskView[]
  readonly projects: readonly ProjectView[]
  readonly staleDays: number
  readonly now: number
  readonly onStatusChange: (id: string, status: TaskStatus) => void
  readonly onComplete: (id: string) => void
  readonly onDelete: (id: string) => void
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

/**
 * Digits pick a column, which is why they are numbered in the help text. The rest follow
 * the arrow keys, with the vi keys alongside them because the hands are already there.
 */
const shortcuts = [
  { keys: '← → h l', does: 'move between columns' },
  { keys: '↑ ↓ j k', does: 'move within a column' },
  // Derived, so the help cannot claim a range the handler does not accept.
  { keys: `1 to ${boardStatuses.length}`, does: 'move the focused task to that column' },
  { keys: 'd', does: 'complete the focused task' },
  { keys: 'r', does: 'mark the focused review done, moving it to Waiting for' },
  { keys: 'a', does: 'accept the suggestion on the focused inbox task' },
  { keys: 'u', does: 'put the focused task’s last status change back' },
  { keys: 'enter', does: 'open the focused task in the details rail' },
  { keys: 'c', does: 'quick capture, from anywhere' },
]

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
  now,
  onStatusChange,
  onComplete,
  onDelete,
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
  const cards = useRef(new Map<string, HTMLElement>())
  const projectTitles = new Map(projects.map((project) => [project.id, project.title]))

  const focus = (id: string | undefined) => {
    if (id !== undefined) cards.current.get(id)?.focus()
  }

  // An action key can move or remove the focused card, and the browser has nothing sensible to
  // fall back on when the element it was tracking leaves the DOM: focus drops to `<body>`, and
  // the very next keypress reaches nothing. Each handler below records where focus should land
  // once the re-render this action causes has happened; the effect then claims it, the same way
  // `move` already focuses synchronously within a render that does not unmount anything.
  const pendingFocusId = useRef<string | null>(null)

  useEffect(() => {
    const id = pendingFocusId.current
    if (id === null) return
    pendingFocusId.current = null
    focus(id)
  })

  /** The card to land on once the focused one disappears from the board, such as on completion. */
  const neighborId = (columnIndex: number, rowIndex: number): string | null => {
    const column = columns[columnIndex] ?? []
    return column[rowIndex + 1]?.id ?? column[rowIndex - 1]?.id ?? null
  }

  /**
   * The keyboard grid. Moving across columns keeps the row where it can and lands on the
   * last card where it cannot, so a short column never swallows the focus.
   */
  const handleKeyDown = (
    event: KeyboardEvent<HTMLElement>,
    columnIndex: number,
    rowIndex: number,
  ) => {
    // Only keys raised on the card itself. The card holds a status select and buttons, and
    // their keys are theirs: an ArrowDown inside the select picks an option, and taking it
    // for a board move would leave that select unusable from the keyboard, which is the very
    // path it exists to provide.
    if (event.target !== event.currentTarget) return

    const task = columns[columnIndex]?.[rowIndex]
    if (task === undefined) return

    const move = (nextColumn: number, nextRow: number) => {
      event.preventDefault()
      const column = columns[nextColumn]
      if (column === undefined || column.length === 0) return
      focus(column[Math.min(nextRow, column.length - 1)]?.id)
    }

    switch (event.key) {
      case 'ArrowDown':
      case 'j':
        return move(columnIndex, rowIndex + 1)
      case 'ArrowUp':
      case 'k':
        return move(columnIndex, Math.max(0, rowIndex - 1))
      case 'ArrowRight':
      case 'l':
        return move(Math.min(columns.length - 1, columnIndex + 1), rowIndex)
      case 'ArrowLeft':
      case 'h':
        return move(Math.max(0, columnIndex - 1), rowIndex)
      case 'd':
        event.preventDefault()
        pendingFocusId.current = neighborId(columnIndex, rowIndex)
        return onComplete(task.id)
      case 'r':
        // The board is fully operable by keyboard alone, including marking a review done.
        // Spec 08, criterion 8. The same predicate the card's button uses, so the two cannot
        // disagree about which tasks the action applies to.
        event.preventDefault()
        if (canMarkReviewed(task)) {
          pendingFocusId.current = task.id
          onMarkReviewed(task.id)
        }
        return
      case 'a':
        // Spec 04 asks for a one-click accept; from the keyboard it is one key. Silent on a task
        // with nothing suggested, rather than doing something else instead.
        event.preventDefault()
        if (task.proposal !== null) {
          pendingFocusId.current = task.id
          onAcceptProposal(task.id)
        }
        return
      case 'Enter':
        // The card's own key, not the title button's: a key raised inside the card returns above.
        // Opening the details is a read, so it is safe on any task and silent on none. Spec 08.
        event.preventDefault()
        return onSelect({ kind: 'task', id: task.id })
      case 'u':
        // A board move is one keypress, so putting one back is one too. Silent on a task that has
        // never been moved, where there is nothing to put back. Spec 08, criterion 17.
        event.preventDefault()
        if (task.previousStatus !== null) {
          pendingFocusId.current = task.id
          onUndoStatus(task.id)
        }
        return
      default:
        break
    }

    const digit = Number(event.key)
    if (Number.isInteger(digit) && digit >= 1 && digit <= boardStatuses.length) {
      const status = boardStatuses[digit - 1]
      event.preventDefault()
      if (status !== undefined && status !== task.status) {
        pendingFocusId.current = task.id
        onStatusChange(task.id, status)
      }
    }
  }

  const onDrop = (event: DragEvent<HTMLElement>, status: TaskStatus) => {
    event.preventDefault()
    const id = event.dataTransfer.getData('text/plain')
    if (id !== '') onStatusChange(id, status)
  }

  return (
    <div className="board-surface">
      <h1>Board</h1>

      {/* No list role over the columns. Each is a region with an accessible name, which is
          already navigable; wrapping them in list semantics replaces that and costs the headings
          their place in the outline. Spec 08, accessibility. */}
      <div className="board">
        {boardStatuses.map((status, columnIndex) => {
          const column = columns[columnIndex] ?? []

          return (
            <Panel
              key={status}
              className="column"
              headingClassName="column-heading"
              headingLevel={2}
              label={`${statusLabel(status)}, ${column.length} ${
                column.length === 1 ? 'task' : 'tasks'
              }`}
              heading={
                <>
                  <span className="column-number" aria-hidden="true">
                    {columnIndex + 1}
                  </span>
                  {statusLabel(status)}
                  <span className="column-count">{column.length}</span>
                </>
              }
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => onDrop(event, status)}
            >
              {column.length === 0 ? (
                <p className="empty">Nothing here.</p>
              ) : (
                <ul className="column-cards">
                  {column.map((task, rowIndex) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      {...(task.projectId !== null && projectTitles.has(task.projectId)
                        ? { projectTitle: projectTitles.get(task.projectId) }
                        : {})}
                      staleDays={staleDays}
                      now={now}
                      onStatusChange={onStatusChange}
                      onComplete={onComplete}
                      onDelete={onDelete}
                      onMarkReviewed={onMarkReviewed}
                      onAcceptProposal={onAcceptProposal}
                      onDismissProposal={onDismissProposal}
                      onUndoStatus={onUndoStatus}
                      onSelect={onSelect}
                      selected={selected?.kind === 'task' && selected.id === task.id}
                      onKeyDown={(event) => handleKeyDown(event, columnIndex, rowIndex)}
                      registerRef={(id, element) => {
                        if (element === null) cards.current.delete(id)
                        else cards.current.set(id, element)
                      }}
                    />
                  ))}
                </ul>
              )}
            </Panel>
          )
        })}
      </div>

      <section className="shortcuts" aria-labelledby="shortcuts-heading">
        <h2 id="shortcuts-heading">Keyboard</h2>
        {/* A key and what it does is the same label-and-value pair the cards and the job panels
            show, so it is the same primitive. Spec 10. */}
        <Facts className="shortcut-facts">
          {shortcuts.map((shortcut) => (
            <Fact key={shortcut.keys} label={shortcut.keys}>
              {shortcut.does}
            </Fact>
          ))}
        </Facts>
      </section>
    </div>
  )
}

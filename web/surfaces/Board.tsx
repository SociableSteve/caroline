/**
 * The board: one column per status, drag between them to set a status, and the same moves
 * available from the keyboard alone. Spec 08 criteria 3 and 8.
 */
import { useRef, type DragEvent, type KeyboardEvent } from 'react'
import { boardStatuses, type ProjectView, type TaskStatus, type TaskView } from '../api.js'
import { byOldestFirst, canMarkReviewed, statusLabel } from '../format.js'
import { TaskCard } from '../components/TaskCard.js'

export interface BoardProps {
  readonly tasks: readonly TaskView[]
  readonly projects: readonly ProjectView[]
  readonly staleDays: number
  readonly now: number
  readonly onStatusChange: (id: string, status: TaskStatus) => void
  readonly onComplete: (id: string) => void
  readonly onDelete: (id: string) => void
  readonly onMarkReviewed: (id: string) => void
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
}: BoardProps) {
  const grouped = group(tasks)
  const columns = boardStatuses.map((status) => grouped.get(status) ?? [])
  const cards = useRef(new Map<string, HTMLElement>())
  const projectTitles = new Map(projects.map((project) => [project.id, project.title]))

  const focus = (id: string | undefined) => {
    if (id !== undefined) cards.current.get(id)?.focus()
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
        return onComplete(task.id)
      case 'r':
        // The board is fully operable by keyboard alone, including marking a review done.
        // Spec 08, criterion 8. The same predicate the card's button uses, so the two cannot
        // disagree about which tasks the action applies to.
        event.preventDefault()
        if (canMarkReviewed(task)) onMarkReviewed(task.id)
        return
      default:
        break
    }

    const digit = Number(event.key)
    if (Number.isInteger(digit) && digit >= 1 && digit <= boardStatuses.length) {
      const status = boardStatuses[digit - 1]
      event.preventDefault()
      if (status !== undefined && status !== task.status) onStatusChange(task.id, status)
    }
  }

  const onDrop = (event: DragEvent<HTMLElement>, status: TaskStatus) => {
    event.preventDefault()
    const id = event.dataTransfer.getData('text/plain')
    if (id !== '') onStatusChange(id, status)
  }

  return (
    <div className="board-surface">
      <div className="board" role="list" aria-label="Board columns">
        {boardStatuses.map((status, columnIndex) => {
          const column = columns[columnIndex] ?? []

          return (
            <section
              key={status}
              className="column"
              role="listitem"
              aria-label={`${statusLabel(status)}, ${column.length} ${
                column.length === 1 ? 'task' : 'tasks'
              }`}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => onDrop(event, status)}
            >
              <h2 className="column-heading">
                <span className="column-number" aria-hidden="true">
                  {columnIndex + 1}
                </span>
                {statusLabel(status)}
                <span className="column-count">{column.length}</span>
              </h2>

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
                      onKeyDown={(event) => handleKeyDown(event, columnIndex, rowIndex)}
                      registerRef={(id, element) => {
                        if (element === null) cards.current.delete(id)
                        else cards.current.set(id, element)
                      }}
                    />
                  ))}
                </ul>
              )}
            </section>
          )
        })}
      </div>

      <section className="shortcuts" aria-labelledby="shortcuts-heading">
        <h2 id="shortcuts-heading">Keyboard</h2>
        <dl>
          {shortcuts.map((shortcut) => (
            <div key={shortcut.keys}>
              <dt>{shortcut.keys}</dt>
              <dd>{shortcut.does}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  )
}

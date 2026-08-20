/**
 * The board: one column per status, drag between them to set a status, and the same moves
 * available from the keyboard alone. Spec 08 criteria 3 and 8.
 */
import { useEffect, useRef, type DragEvent, type KeyboardEvent } from 'react'
import {
  boardStatuses,
  type ItemRef,
  type ProjectView,
  type TaskInput,
  type TaskStatus,
  type TaskView,
} from '../api.js'
import { byOldestFirst, canMarkReviewed, statusLabel } from '../format.js'
import { TaskCard } from '../components/TaskCard.js'
import { emptyClassName, Panel } from '../components/primitives.js'
import { Kbd } from '../components/ui/kbd.js'
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

  /**
   * An action key can move or remove the focused card, and the browser has nothing sensible to
   * fall back on when the element it was tracking leaves the DOM: focus drops to `<body>`, and
   * the very next keypress reaches nothing. Each handler below arms this with the card it acted
   * on and where to land if that card leaves the board, and the effect puts the focus back once
   * the action has actually reached the DOM.
   *
   * The element is held alongside the id because it is what tells the action apart from the
   * renders around it. The write behind an action is asynchronous, so the render that moves the
   * card is not the next one: the clock ticking and a rejected write both come first. While the
   * card is still the same element it was, nothing has happened yet and there is nothing to put
   * back, which is also the answer for a write that failed: the card never moved, so the focus
   * never left it, and a retry stays on the task the user is looking at.
   */
  const pendingFocus = useRef<{
    readonly id: string
    readonly element: HTMLElement | undefined
    readonly fallbackId: string | null
  } | null>(null)

  // Deliberately without a dependency array: it is a render that moves the card, and any render
  // can be the one that does it, so every render is a chance to claim the focus back.
  useEffect(() => {
    const pending = pendingFocus.current
    if (pending === null) return

    const live = cards.current.get(pending.id)
    const active = document.activeElement

    // Nothing has moved yet. Keep waiting while the focus is still on the card the action was
    // asked for; give up once it is not, because then the focus is where the user has put it and
    // a later render must not drag it back.
    if (live === pending.element) {
      if (active !== pending.element) pendingFocus.current = null
      return
    }

    pendingFocus.current = null
    // A focus that is on something real is the user's, not ours to move. Only the drop to
    // `<body>` that unmounting the card causes is ours to answer.
    if (active !== null && active !== document.body) return

    // The card is still on the board in another column, so the focus follows it there; otherwise
    // the task has left the board and the focus lands on the neighbour recorded with it.
    focus(live !== undefined ? pending.id : (pending.fallbackId ?? undefined))
  })

  /**
   * The card to land on once the focused one disappears from the board, such as on completion.
   * The one below it, then the one above it, then the nearest card in the closest column that has
   * one: completing the only card in a column empties it, and a column with nothing in it cannot
   * hold the focus, so stopping there would strand it on `<body>`.
   */
  const neighborId = (columnIndex: number, rowIndex: number): string | null => {
    const column = columns[columnIndex] ?? []
    const withinColumn = column[rowIndex + 1]?.id ?? column[rowIndex - 1]?.id
    if (withinColumn !== undefined) return withinColumn

    for (let distance = 1; distance < columns.length; distance += 1) {
      for (const index of [columnIndex + distance, columnIndex - distance]) {
        const other = columns[index]
        if (other === undefined || other.length === 0) continue
        return other[Math.min(rowIndex, other.length - 1)]?.id ?? null
      }
    }

    // The board is down to this one card, so there is nowhere on it to land.
    return null
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

    /**
     * Every action arms the same way, the card first and the neighbour behind it, because an
     * action that names a status can still take the task off the board: `u` puts the last change
     * back, and a task moved out of `done` has `done` to go back to, which is not a column.
     */
    const armFocus = () => {
      pendingFocus.current = {
        id: task.id,
        element: cards.current.get(task.id),
        fallbackId: neighborId(columnIndex, rowIndex),
      }
    }

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
        armFocus()
        return onComplete(task.id)
      case 'r':
        // The board is fully operable by keyboard alone, including marking a review done.
        // Spec 08, criterion 8. The same predicate the card's button uses, so the two cannot
        // disagree about which tasks the action applies to.
        event.preventDefault()
        if (canMarkReviewed(task)) {
          armFocus()
          onMarkReviewed(task.id)
        }
        return
      case 'a':
        // Spec 04 asks for a one-click accept; from the keyboard it is one key. Silent on a task
        // with nothing suggested, rather than doing something else instead.
        event.preventDefault()
        if (task.proposal !== null) {
          armFocus()
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
          armFocus()
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
        armFocus()
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
    <div className="flex h-full min-h-0 flex-col gap-5">
      <h1 className="shrink-0">Board</h1>

      {/* No list role over the columns. Each is a region with an accessible name, which is
          already navigable; wrapping them in list semantics replaces that and costs the headings
          their place in the outline. Spec 08, accessibility. */}
      <div className="grid min-h-0 flex-1 auto-cols-[minmax(15rem,1fr)] grid-flow-col items-stretch gap-3 overflow-x-auto pb-2 md:grid-flow-row md:grid-cols-6 md:overflow-x-visible">
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
                  <span
                    className="rounded-full border border-border px-2 font-mono text-xs text-muted-foreground [font-variant-numeric:tabular-nums]"
                    aria-hidden="true"
                  >
                    {columnIndex + 1}
                  </span>
                  {statusLabel(status)}
                  <span className="ml-auto rounded-full border border-border px-2 font-mono text-xs text-muted-foreground [font-variant-numeric:tabular-nums]">
                    {column.length}
                  </span>
                </>
              }
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => onDrop(event, status)}
            >
              {column.length === 0 ? (
                <p className={emptyClassName}>Nothing here.</p>
              ) : (
                <ul className="m-0 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-0 [list-style:none]">
                  {column.map((task, rowIndex) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      {...(task.projectId !== null && projectTitles.has(task.projectId)
                        ? { projectTitle: projectTitles.get(task.projectId) }
                        : {})}
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

      <section
        className="shrink-0 border-t border-border bg-card px-5 py-2 text-sm text-muted-foreground"
        aria-labelledby="shortcuts-heading"
      >
        <h2 id="shortcuts-heading" className="m-0 mb-1 text-xs">
          Keyboard
        </h2>
        {/* A row rather than the label-and-value grid `Facts` gives every other pair on the app:
            nine of these across the full width of the board reads better than nine stacked lines,
            and a shortcut key with what it does is still said in one place, together. */}
        <ul className="m-0 flex flex-wrap gap-x-5 gap-y-1 p-0 [list-style:none]">
          {shortcuts.map((shortcut) => (
            <li key={shortcut.keys} className="whitespace-nowrap">
              <Kbd>{shortcut.keys}</Kbd> {shortcut.does}
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}

/**
 * Projects: the list with each project's derived next action and the stalled ones marked, and
 * the drill-in to a project's tasks. Spec 08, and spec 01 criterion 4 seen from the UI.
 */
import { useState } from 'react'
import { cn } from '../lib/utils.js'
import { projectStates } from '../../src/domain/project.js'
import type { ItemRef, ProjectState, ProjectView, TaskInput, TaskStatus, TaskView } from '../api.js'
import { statusLabel } from '../format.js'
import { projectHref, surfaceHref } from '../router.js'
import { TaskCard } from '../components/TaskCard.js'
import {
  ActionRow,
  Badge,
  emptyClassName,
  Field,
  Panel,
  policyNoteClassName,
  tableHeaderClassName,
} from '../components/primitives.js'
import { Button } from '../components/ui/button.js'
import { Input } from '../components/ui/input.js'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select.js'
import { useSurfaceTitle } from '../title.js'

export interface ProjectsProps {
  readonly projects: readonly ProjectView[]
  /**
   * Opens a project in the rail's details region. A project's name already links to its drill-in, so
   * unlike a task it is opened from a control in its row, where a list has the width a card does not.
   * Spec 08.
   */
  readonly onSelect: (item: ItemRef) => void
  readonly selected: ItemRef | null
  /**
   * The hash the drill-in links are built from. The rail is a companion to whichever surface is showing
   * (spec 08), so drilling into a project is not closing it and not leaving the conversation or the open
   * item behind; without this the link dropped all three.
   */
  readonly hash: string
  /** Answers whether the project was created. The field keeps its text until it was. */
  readonly onCreate: (title: string) => Promise<boolean>
  readonly onStateChange: (id: string, state: ProjectState) => void
  readonly onDelete: (id: string) => void
}

const stateLabels: Record<ProjectState, string> = {
  active: 'Active',
  someday: 'Someday',
  done: 'Done',
  dropped: 'Dropped',
}

export function Projects({
  projects,
  selected,
  onSelect,
  hash,
  onCreate,
  onStateChange,
  onDelete,
}: ProjectsProps) {
  const [title, setTitle] = useState('')
  const [saving, setSaving] = useState(false)
  const [confirming, setConfirming] = useState<string | null>(null)

  const create = async () => {
    const sent = title
    const trimmed = sent.trim()
    if (trimmed === '' || saving) return

    setSaving(true)
    let created = false
    try {
      created = await onCreate(trimmed)
    } catch {
      // A rejection is a project that was not created, which is what `false` already means.
      created = false
    } finally {
      // In a `finally`, so neither path can leave the button disabled for good.
      setSaving(false)
    }

    // Cleared only once it landed, and only if it still holds what was sent: the field stays
    // editable while the request is out, so a newer title is the next project, not this one.
    if (created) setTitle((current) => (current === sent ? '' : current))
  }

  useSurfaceTitle('Projects')

  return (
    <div className="flex flex-col gap-5">
      <h1>Projects</h1>

      {/* The heading is for structure, not for reading: issue #47's mockup goes straight from the
          page's own "Projects" heading into the toolbar and table, with no second visible
          heading above them. Kept for a11y as a labelled region, just not shown. */}
      <Panel headingLevel={2} heading="All projects" headingClassName="sr-only">
        {/* Inline capture in the header row, per issue #47, rather than a form of its own above
            the table. */}
        <form
          className="mb-3 flex flex-wrap items-end justify-end gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void create()
          }}
        >
          <Field label="Outcome, phrased as a result">
            <Input
              className="h-8 w-[300px] text-xs"
              name="title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              autoComplete="off"
            />
          </Field>
          <Button
            type="submit"
            size="sm"
            className="h-8 px-3 text-xs"
            disabled={title.trim() === '' || saving}
          >
            Add project
          </Button>
        </form>

        {projects.length === 0 ? (
          <p className={emptyClassName}>
            No projects yet. A project is an outcome that takes more than one action.
          </p>
        ) : (
          <>
            <table className="w-full border-collapse overflow-hidden rounded-xl border">
              <thead>
                <tr>
                  <th scope="col" className={tableHeaderClassName}>
                    Project
                  </th>
                  <th scope="col" className={tableHeaderClassName}>
                    Next action
                  </th>
                  <th scope="col" className={tableHeaderClassName}>
                    State
                  </th>
                  <th scope="col" className={tableHeaderClassName}>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {projects.map((project) => (
                  <tr
                    key={project.id}
                    className={cn(
                      '[&>td]:border-b [&>td]:border-border/60 [&>td]:p-2 [&>td]:align-top',
                      project.stalled && 'bg-destructive/[0.04]',
                    )}
                  >
                    <td>
                      <a
                        className="text-[13px] font-medium"
                        href={surfaceHref(projectHref(project.id), hash)}
                      >
                        {project.title}
                      </a>
                      {/* Colour is not the only carrier: the word is on the row too. */}
                      {project.stalled && (
                        <>
                          {' '}
                          <Badge tone="alarm">Stalled</Badge>
                        </>
                      )}
                    </td>

                    <td>
                      <p className="m-0 text-xs">
                        {project.nextAction === null ? (
                          <span className={project.stalled ? 'text-destructive' : undefined}>
                            No next action
                          </span>
                        ) : (
                          project.nextAction.title
                        )}
                      </p>
                    </td>

                    <td>
                      {/* A pill, not a dropdown: issue #47's mockup draws state as a plain badge
                          like Board's own stale and pushed pills. shadcn's stock `Select`, so the
                          control is still real and one click away; only its skin changes. */}
                      <Field label={`State of ${project.title}`} hiddenLabel>
                        <Select
                          value={project.state}
                          onValueChange={(value) =>
                            onStateChange(project.id, value as ProjectState)
                          }
                        >
                          <SelectTrigger size="sm" className="rounded-full text-[11px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {projectStates.map((state) => (
                              <SelectItem key={state} value={state}>
                                {stateLabels[state]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </Field>
                    </td>

                    <td>
                      <ActionRow>
                        <Button
                          type="button"
                          variant="outline"
                          size="xs"
                          className="px-2.5"
                          aria-pressed={selected?.kind === 'project' && selected.id === project.id}
                          onClick={() => onSelect({ kind: 'project', id: project.id })}
                        >
                          Details
                        </Button>

                        {confirming === project.id ? (
                          <>
                            <Button
                              type="button"
                              variant="outline"
                              size="xs"
                              className="px-2.5 text-muted-foreground"
                              onClick={() => {
                                setConfirming(null)
                                onDelete(project.id)
                              }}
                            >
                              Confirm delete
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              size="xs"
                              className="px-2.5 text-muted-foreground"
                              onClick={() => setConfirming(null)}
                            >
                              Keep
                            </Button>
                          </>
                        ) : (
                          <Button
                            type="button"
                            variant="outline"
                            size="xs"
                            className="px-2.5 text-muted-foreground"
                            onClick={() => setConfirming(project.id)}
                          >
                            Delete
                          </Button>
                        )}
                      </ActionRow>

                      {confirming === project.id && (
                        <p className="text-destructive">
                          Its tasks are kept and lose their project, rather than being deleted.
                        </p>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <p className={policyNoteClassName}>
              Deleting a project keeps its tasks; they lose their project rather than being deleted.
            </p>
          </>
        )}
      </Panel>
    </div>
  )
}

export interface ProjectDetailProps {
  readonly project: ProjectView | undefined
  readonly tasks: readonly TaskView[]
  readonly staleDays: number
  /** The zone a due or defer-until date typed into a card resolves in. Spec 06. */
  readonly timezone: string
  /** Whether `timezone` is the deployment's real configured zone yet, rather than the UTC
   *  default it starts as. A card disables its date fields until this is true. */
  readonly configLoaded: boolean
  readonly now: number
  readonly onStatusChange: (id: string, status: TaskStatus) => void
  readonly onComplete: (id: string) => void
  readonly onDelete: (id: string) => void
  readonly onDatesChange: (
    id: string,
    patch: Partial<Pick<TaskInput, 'dueAt' | 'deferUntil'>>,
  ) => void
  readonly onSelect: (item: ItemRef) => void
  readonly selected: ItemRef | null
  /** The hash the way back out is built from, so leaving the drill-in keeps the rail. Spec 08. */
  readonly hash: string
}

export function ProjectDetail({
  project,
  tasks,
  staleDays,
  timezone,
  configLoaded,
  now,
  onStatusChange,
  onComplete,
  onDelete,
  onDatesChange,
  onSelect,
  selected,
  hash,
}: ProjectDetailProps) {
  // The drill-in's name is the project's, which is what makes two of them tell apart in history.
  useSurfaceTitle(project?.title ?? 'Project')

  if (project === undefined) {
    return (
      <div className="flex max-w-[76ch] flex-col gap-2">
        <h1>Project</h1>
        <p role="alert">That project is not here. It may have been deleted.</p>
        <a href={surfaceHref('#/projects', hash)}>Back to projects</a>
      </div>
    )
  }

  const open = tasks.filter((task) => task.status !== 'done')

  return (
    <div className="flex max-w-[76ch] flex-col gap-2">
      <a href={surfaceHref('#/projects', hash)}>Back to projects</a>
      <h1>{project.title}</h1>

      <p>
        <span className="text-sm text-muted-foreground">State</span> {stateLabels[project.state]}
        {project.stalled && (
          <>
            {' '}
            <Badge tone="alarm">Stalled</Badge>
          </>
        )}
      </p>

      {project.notes !== null && <p>{project.notes}</p>}

      <p className="text-sm">
        <span className="text-sm text-muted-foreground">Next action</span>{' '}
        {project.nextAction === null ? 'none' : project.nextAction.title}
      </p>

      {project.state === 'done' && open.length > 0 && (
        <p className="text-destructive" role="status">
          This project is done, but {open.length} of its tasks are still open.
        </p>
      )}

      <h2>Tasks</h2>
      {tasks.length === 0 ? (
        <p className={emptyClassName}>No tasks in this project yet.</p>
      ) : (
        <ul className="m-0 flex flex-col gap-2 p-0 [list-style:none]">
          {tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              staleDays={staleDays}
              timezone={timezone}
              configLoaded={configLoaded}
              now={now}
              onStatusChange={onStatusChange}
              onComplete={onComplete}
              onDelete={onDelete}
              onDatesChange={onDatesChange}
              onSelect={onSelect}
              selected={selected?.kind === 'task' && selected.id === task.id}
            />
          ))}
        </ul>
      )}

      <p className="m-0 text-sm">
        {open.length} open, {tasks.length - open.length} done, across{' '}
        {new Set(tasks.map((task) => statusLabel(task.status))).size} statuses.
      </p>
    </div>
  )
}

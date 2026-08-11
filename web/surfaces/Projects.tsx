/**
 * Projects: the list with each project's derived next action and the stalled ones marked, and
 * the drill-in to a project's tasks. Spec 08, and spec 01 criterion 4 seen from the UI.
 */
import { useState } from 'react'
import { projectStates } from '../../src/domain/project.js'
import type { ItemRef, ProjectState, ProjectView, TaskStatus, TaskView } from '../api.js'
import { statusLabel } from '../format.js'
import { projectHref, surfaceHref } from '../router.js'
import { TaskCard } from '../components/TaskCard.js'
import { ActionRow, Badge, Field, Panel } from '../components/primitives.js'
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
    <div className="projects">
      <h1>Projects</h1>

      <Panel headingLevel={2} heading="New project">
        <form
          className="inline-form"
          onSubmit={(event) => {
            event.preventDefault()
            void create()
          }}
        >
          <Field label="Outcome, phrased as a result">
            <input
              name="title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              autoComplete="off"
            />
          </Field>
          <button type="submit" disabled={title.trim() === '' || saving}>
            Add project
          </button>
        </form>
      </Panel>

      <Panel headingLevel={2} heading="All projects">
        {projects.length === 0 ? (
          <p className="empty">
            No projects yet. A project is an outcome that takes more than one action.
          </p>
        ) : (
          <ul className="project-list">
            {projects.map((project) => (
              <li
                key={project.id}
                className={`project${project.stalled ? ' stalled' : ''}${
                  selected?.kind === 'project' && selected.id === project.id ? ' project-open' : ''
                }`}
              >
                <h3>
                  <a href={surfaceHref(projectHref(project.id), hash)}>{project.title}</a>
                </h3>

                <p className="project-next">
                  {project.nextAction === null ? (
                    <>
                      <span>No next action</span>
                      {/* Colour is not the only carrier: the word is on the card. */}
                      {project.stalled && (
                        <>
                          {' '}
                          <Badge tone="alarm">Stalled</Badge>
                        </>
                      )}
                    </>
                  ) : (
                    <>
                      <span className="label">Next action</span> {project.nextAction.title}
                    </>
                  )}
                </p>

                <ActionRow>
                  <button
                    type="button"
                    aria-pressed={selected?.kind === 'project' && selected.id === project.id}
                    onClick={() => onSelect({ kind: 'project', id: project.id })}
                  >
                    Details
                  </button>

                  <Field label={`State of ${project.title}`} hiddenLabel>
                    <select
                      value={project.state}
                      onChange={(event) =>
                        onStateChange(project.id, event.target.value as ProjectState)
                      }
                    >
                      {projectStates.map((state) => (
                        <option key={state} value={state}>
                          {stateLabels[state]}
                        </option>
                      ))}
                    </select>
                  </Field>

                  {confirming === project.id ? (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          setConfirming(null)
                          onDelete(project.id)
                        }}
                      >
                        Confirm delete
                      </button>
                      <button type="button" onClick={() => setConfirming(null)}>
                        Keep
                      </button>
                    </>
                  ) : (
                    <button type="button" onClick={() => setConfirming(project.id)}>
                      Delete
                    </button>
                  )}
                </ActionRow>

                {confirming === project.id && (
                  <p className="warning">
                    Its tasks are kept and lose their project, rather than being deleted.
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  )
}

export interface ProjectDetailProps {
  readonly project: ProjectView | undefined
  readonly tasks: readonly TaskView[]
  readonly staleDays: number
  readonly now: number
  readonly onStatusChange: (id: string, status: TaskStatus) => void
  readonly onComplete: (id: string) => void
  readonly onDelete: (id: string) => void
  readonly onSelect: (item: ItemRef) => void
  readonly selected: ItemRef | null
  /** The hash the way back out is built from, so leaving the drill-in keeps the rail. Spec 08. */
  readonly hash: string
}

export function ProjectDetail({
  project,
  tasks,
  staleDays,
  now,
  onStatusChange,
  onComplete,
  onDelete,
  onSelect,
  selected,
  hash,
}: ProjectDetailProps) {
  // The drill-in's name is the project's, which is what makes two of them tell apart in history.
  useSurfaceTitle(project?.title ?? 'Project')

  if (project === undefined) {
    return (
      <div className="project-detail">
        <h1>Project</h1>
        <p role="alert">That project is not here. It may have been deleted.</p>
        <a href={surfaceHref('#/projects', hash)}>Back to projects</a>
      </div>
    )
  }

  const open = tasks.filter((task) => task.status !== 'done')

  return (
    <div className="project-detail">
      <a href={surfaceHref('#/projects', hash)}>Back to projects</a>
      <h1>{project.title}</h1>

      <p className="project-state">
        <span className="label">State</span> {stateLabels[project.state]}
        {project.stalled && (
          <>
            {' '}
            <Badge tone="alarm">Stalled</Badge>
          </>
        )}
      </p>

      {project.notes !== null && <p className="project-notes">{project.notes}</p>}

      <p className="project-next">
        <span className="label">Next action</span>{' '}
        {project.nextAction === null ? 'none' : project.nextAction.title}
      </p>

      {project.state === 'done' && open.length > 0 && (
        <p className="warning" role="status">
          This project is done, but {open.length} of its tasks are still open.
        </p>
      )}

      <h2>Tasks</h2>
      {tasks.length === 0 ? (
        <p className="empty">No tasks in this project yet.</p>
      ) : (
        <ul className="column-cards">
          {tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              staleDays={staleDays}
              now={now}
              onStatusChange={onStatusChange}
              onComplete={onComplete}
              onDelete={onDelete}
              onSelect={onSelect}
              selected={selected?.kind === 'task' && selected.id === task.id}
            />
          ))}
        </ul>
      )}

      <p className="project-summary">
        {open.length} open, {tasks.length - open.length} done, across{' '}
        {new Set(tasks.map((task) => statusLabel(task.status))).size} statuses.
      </p>
    </div>
  )
}

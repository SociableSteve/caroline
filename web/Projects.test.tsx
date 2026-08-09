/**
 * The projects surface: the derived next action, the stalled marker, and the drill-in.
 * Spec 01 criteria 4 and 6 as the user meets them.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { ProjectDetail, Projects } from './surfaces/Projects.js'
import { aProject, aTask, NOW } from './test-fixtures.js'

function renderProjects(overrides: Partial<Parameters<typeof Projects>[0]> = {}) {
  const handlers = {
    onCreate: vi.fn(),
    onStateChange: vi.fn(),
    onDelete: vi.fn(),
  }

  render(<Projects projects={[]} {...handlers} {...overrides} />)

  return handlers
}

describe('the projects list', () => {
  it('explains what a project is when there are none', () => {
    renderProjects()

    expect(screen.getByText(/No projects yet/)).toBeInTheDocument()
  })

  it('names the derived next action', () => {
    renderProjects({
      projects: [
        aProject({
          id: 'project-1',
          title: 'Ship it',
          stalled: false,
          nextAction: aTask({ id: 'task-1', title: 'Write the release notes' }),
        }),
      ],
    })

    expect(screen.getByText('Write the release notes')).toBeInTheDocument()
  })

  it('marks a stalled project in words as well as by class', () => {
    renderProjects({ projects: [aProject({ id: 'project-1', title: 'Ship it', stalled: true })] })

    expect(screen.getByText('Stalled')).toBeInTheDocument()
    expect(screen.getByText('No next action')).toBeInTheDocument()
  })

  it('links each project to its own view', () => {
    renderProjects({ projects: [aProject({ id: 'project-1', title: 'Ship it' })] })

    expect(screen.getByRole('link', { name: 'Ship it' })).toHaveAttribute(
      'href',
      '#/projects/project-1',
    )
  })

  it('creates a project from the form, trimming what was typed', async () => {
    const handlers = renderProjects()

    await userEvent.type(screen.getByLabelText(/Outcome/), '  Ship it  ')
    await userEvent.click(screen.getByRole('button', { name: 'Add project' }))

    expect(handlers.onCreate).toHaveBeenCalledWith('Ship it')
  })

  it('will not create a project with no title', () => {
    renderProjects()

    expect(screen.getByRole('button', { name: 'Add project' })).toBeDisabled()
  })

  it('changes a project state', async () => {
    const handlers = renderProjects({
      projects: [aProject({ id: 'project-1', title: 'Ship it' })],
    })

    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'State of Ship it' }),
      'someday',
    )

    expect(handlers.onStateChange).toHaveBeenCalledWith('project-1', 'someday')
  })

  /** Criterion 6 is a promise worth making in the UI too, not only in the database. */
  it('says what happens to the tasks before deleting a project', async () => {
    const handlers = renderProjects({
      projects: [aProject({ id: 'project-1', title: 'Ship it' })],
    })

    await userEvent.click(screen.getByRole('button', { name: 'Delete' }))

    expect(screen.getByText(/tasks are kept and lose their project/)).toBeInTheDocument()
    expect(handlers.onDelete).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: 'Confirm delete' }))
    expect(handlers.onDelete).toHaveBeenCalledWith('project-1')
  })
})

function renderDetail(overrides: Partial<Parameters<typeof ProjectDetail>[0]> = {}) {
  const handlers = {
    onStatusChange: vi.fn(),
    onComplete: vi.fn(),
    onDelete: vi.fn(),
  }

  render(
    <ProjectDetail
      project={aProject({ id: 'project-1', title: 'Ship it' })}
      tasks={[]}
      staleDays={7}
      now={NOW}
      {...handlers}
      {...overrides}
    />,
  )

  return handlers
}

describe('a project on its own', () => {
  it('shows its tasks as cards', () => {
    renderDetail({ tasks: [aTask({ id: 'task-1', title: 'Write the release notes' })] })

    expect(screen.getByRole('article', { name: 'Write the release notes' })).toBeInTheDocument()
  })

  it('shows an empty state when it has no tasks yet', () => {
    renderDetail()

    expect(screen.getByText('No tasks in this project yet.')).toBeInTheDocument()
  })

  it('changes the status of one of its tasks', async () => {
    const handlers = renderDetail({ tasks: [aTask({ id: 'task-1', title: 'Do the thing' })] })

    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Status of Do the thing' }),
      'next_action',
    )

    expect(handlers.onStatusChange).toHaveBeenCalledWith('task-1', 'next_action')
  })

  /** Spec 01: completing a project does not complete its tasks, and the UI flags what is left. */
  it('flags open tasks on a project that has been marked done', () => {
    renderDetail({
      project: aProject({ id: 'project-1', title: 'Ship it', state: 'done', stalled: false }),
      tasks: [aTask({ id: 'task-1', title: 'Still open' })],
    })

    expect(screen.getByRole('status')).toHaveTextContent('1 of its tasks are still open')
  })

  it('says so when the project is not there rather than rendering an empty page', () => {
    renderDetail({ project: undefined })

    expect(screen.getByRole('alert')).toHaveTextContent(/not here/)
    expect(screen.getByRole('link', { name: 'Back to projects' })).toBeInTheDocument()
  })
})

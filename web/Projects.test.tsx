/**
 * The projects surface: the derived next action, the stalled marker, and the drill-in.
 * Spec 01 criteria 4 and 6 as the user meets them.
 */
import { describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { ProjectDetail, Projects } from './surfaces/Projects.js'
import { parseLocation } from './router.js'
import { aProject, aTask, NOW } from './test-fixtures.js'

function renderProjects(overrides: Partial<Parameters<typeof Projects>[0]> = {}) {
  const handlers = {
    // Creating answers whether it worked, which is what the form waits for.
    onCreate: vi.fn(async () => true),
    onStateChange: vi.fn(),
    onDelete: vi.fn(),
    onSelect: vi.fn(),
  }

  render(<Projects projects={[]} selected={null} hash="#/projects" {...handlers} {...overrides} />)

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

  it('clears the field once the project has been created', async () => {
    renderProjects()

    await userEvent.type(screen.getByLabelText(/Outcome/), 'Ship it')
    await userEvent.click(screen.getByRole('button', { name: 'Add project' }))

    expect(screen.getByLabelText(/Outcome/)).toHaveValue('')
  })

  /** Losing what was typed is a worse outcome than the failure that caused it. */
  it('keeps what was typed when the create is refused', async () => {
    renderProjects({ onCreate: vi.fn(async () => false) })

    await userEvent.type(screen.getByLabelText(/Outcome/), 'Ship it')
    await userEvent.click(screen.getByRole('button', { name: 'Add project' }))

    expect(screen.getByLabelText(/Outcome/)).toHaveValue('Ship it')
  })

  it('keeps a title typed while the first create was still in flight', async () => {
    let release: (created: boolean) => void = () => {}
    renderProjects({
      onCreate: vi.fn(() => new Promise<boolean>((resolve) => (release = resolve))),
    })

    await userEvent.type(screen.getByLabelText(/Outcome/), 'First outcome')
    await userEvent.click(screen.getByRole('button', { name: 'Add project' }))
    await userEvent.clear(screen.getByLabelText(/Outcome/))
    await userEvent.type(screen.getByLabelText(/Outcome/), 'Second outcome')

    // Released and then flushed, so the assertion is made after the code that would clear the
    // field has had its turn. A `waitFor` alone would pass before it ran.
    release(true)
    await act(async () => {})

    expect(screen.getByLabelText(/Outcome/)).toHaveValue('Second outcome')
  })

  it('can be tried again after the create rejects rather than resolving', async () => {
    renderProjects({
      onCreate: vi.fn(async () => {
        throw new Error('the network went away')
      }),
    })

    await userEvent.type(screen.getByLabelText(/Outcome/), 'Ship it')
    await userEvent.click(screen.getByRole('button', { name: 'Add project' }))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Add project' })).toBeEnabled())
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
    onDatesChange: vi.fn(),
    onSelect: vi.fn(),
  }

  render(
    <ProjectDetail
      project={aProject({ id: 'project-1', title: 'Ship it' })}
      tasks={[]}
      staleDays={7}
      now={NOW}
      selected={null}
      hash="#/projects/project-1"
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

/** Spec 08: a project's name already links to its drill-in, so its row carries the control instead. */
describe('opening a project in the details rail', () => {
  it('opens the project whose row was asked for', async () => {
    const handlers = renderProjects({
      projects: [aProject({ id: 'project-1', title: 'Ship it' })],
    })

    await userEvent.click(screen.getByRole('button', { name: 'Details' }))

    expect(handlers.onSelect).toHaveBeenCalledWith({ kind: 'project', id: 'project-1' })
  })

  it('says which row is the one that is open', () => {
    renderProjects({
      projects: [aProject({ id: 'project-1', title: 'Ship it' })],
      selected: { kind: 'project', id: 'project-1' },
    })

    expect(screen.getByRole('button', { name: 'Details' })).toHaveAttribute('aria-pressed', 'true')
  })

  /** The name is still the link to the project's own surface: opening the rail did not take it. */
  it('leaves the name as the link to the drill-in', () => {
    renderProjects({ projects: [aProject({ id: 'project-1', title: 'Ship it' })] })

    expect(screen.getByRole('link', { name: 'Ship it' })).toHaveAttribute(
      'href',
      '#/projects/project-1',
    )
  })
})

/**
 * Spec 08, criterion 32. The rail is a companion to whichever surface is showing, so drilling into a
 * project is not closing it and not leaving the conversation behind either: the drill-in link carries
 * the rail's parameters exactly as the navigation does.
 */
describe('the drill-in link', () => {
  it('carries the open conversation and the open item into the drill-in', () => {
    renderProjects({
      projects: [aProject({ id: 'project-1', title: 'Ship it' })],
      hash: '#/projects?conversation=abc&item=task%3Atask-1',
    })

    const href = screen.getByRole('link', { name: 'Ship it' }).getAttribute('href') ?? ''

    expect(parseLocation(href)).toMatchObject({
      route: { name: 'project', id: 'project-1' },
      conversationId: 'abc',
      selected: { kind: 'task', id: 'task-1' },
    })
  })

  it('carries a closed rail in, so drilling into a project does not reopen it', () => {
    renderProjects({
      projects: [aProject({ id: 'project-1', title: 'Ship it' })],
      hash: '#/projects?chat=closed',
    })

    expect(screen.getByRole('link', { name: 'Ship it' })).toHaveAttribute(
      'href',
      '#/projects/project-1?chat=closed',
    )
  })

  it('leaves behind the parameters that belonged to the surface being left', () => {
    renderProjects({
      projects: [aProject({ id: 'project-1', title: 'Ship it' })],
      hash: '#/settings?google=connected&conversation=abc',
    })

    expect(screen.getByRole('link', { name: 'Ship it' })).toHaveAttribute(
      'href',
      '#/projects/project-1?conversation=abc',
    )
  })
})

/**
 * The same guarantee in the other direction. Spec 08, criterion 32: the drill-in carries the rail in,
 * so the way back out has to carry it too, or an open conversation survives half the journey.
 */
describe('the way back out of a drill-in', () => {
  it('carries the open conversation and the open item back to the list', () => {
    renderDetail({ hash: '#/projects/project-1?conversation=abc&item=task%3Atask-1' })

    const href = screen.getByRole('link', { name: 'Back to projects' }).getAttribute('href') ?? ''

    expect(parseLocation(href)).toMatchObject({
      route: { name: 'projects' },
      conversationId: 'abc',
      selected: { kind: 'task', id: 'task-1' },
    })
  })

  it('carries it back from a project that is not there either', () => {
    renderDetail({ project: undefined, hash: '#/projects/gone?conversation=abc' })

    expect(screen.getByRole('link', { name: 'Back to projects' })).toHaveAttribute(
      'href',
      '#/projects?conversation=abc',
    )
  })
})

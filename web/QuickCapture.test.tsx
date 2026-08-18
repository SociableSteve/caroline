/**
 * Quick capture's modal contract. `aria-modal="true"` tells a screen reader the rest of the
 * page is inert, so Tab has to agree with it, and closing has to give the focus back to
 * whatever opened it. Not borrowed from `<dialog>`, therefore tested here.
 */
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { useState } from 'react'
import { QuickCapture } from './components/QuickCapture.js'
import { deferUntilFromDateInput, dueAtFromDateInput } from './format.js'
import { aProject } from './test-fixtures.js'

/** The dialog as the app uses it: something focusable outside it, and an opener button. */
function Harness({
  onCreate,
  configLoaded = true,
}: {
  onCreate: (input: unknown) => Promise<boolean>
  /** Defaulted to true: most of this suite is about the dialog's own contract, not the
   *  timezone race, and should see the fields as ready as they normally are. */
  configLoaded?: boolean
}) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Quick capture
      </button>
      <button type="button">Background control</button>
      <QuickCapture
        open={open}
        projects={[aProject({ id: 'project-1', title: 'Ship it' })]}
        timezone="UTC"
        configLoaded={configLoaded}
        onClose={() => setOpen(false)}
        onCreate={onCreate}
      />
    </>
  )
}

async function openCapture(onCreate = vi.fn(async () => true), configLoaded = true) {
  render(<Harness onCreate={onCreate} configLoaded={configLoaded} />)
  await userEvent.click(screen.getByRole('button', { name: 'Quick capture' }))

  return onCreate
}

describe('opening and closing', () => {
  it('puts the caret in the title field', async () => {
    await openCapture()

    expect(screen.getByLabelText('What is it?')).toHaveFocus()
  })

  it('gives the focus back to whatever opened it', async () => {
    await openCapture()

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.getByRole('button', { name: 'Quick capture' })).toHaveFocus()
  })

  it('gives the focus back after Escape too', async () => {
    await openCapture()

    await userEvent.keyboard('{Escape}')

    expect(screen.getByRole('button', { name: 'Quick capture' })).toHaveFocus()
  })

  /**
   * Escape has to work whatever inside the dialog holds the focus, and while a capture is in
   * flight the focus is nowhere: submitting disables the Capture button, so the focus falls to
   * the body and a handler on the backdrop never sees the key.
   */
  it('closes on Escape while a capture is still in flight', async () => {
    await openCapture(vi.fn(() => new Promise<boolean>(() => {})))

    await userEvent.type(screen.getByLabelText('What is it?'), 'Renew the domain')
    await userEvent.click(screen.getByRole('button', { name: 'Capture' }))
    await userEvent.keyboard('{Escape}')

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

describe('the focus trap', () => {
  it('cycles from the last control back to the first rather than leaving the dialog', async () => {
    await openCapture()
    // With a title typed, every control in the dialog is enabled and so in the tab order.
    await userEvent.type(screen.getByLabelText('What is it?'), 'Renew the domain')

    await userEvent.tab()
    expect(screen.getByLabelText('Notes')).toHaveFocus()

    await userEvent.tab()
    expect(screen.getByLabelText('Project')).toHaveFocus()

    await userEvent.tab()
    expect(screen.getByLabelText('Due')).toHaveFocus()

    await userEvent.tab()
    expect(screen.getByLabelText('Defer until')).toHaveFocus()

    await userEvent.tab()
    expect(screen.getByRole('button', { name: 'Capture' })).toHaveFocus()

    await userEvent.tab()
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()

    await userEvent.tab()
    expect(screen.getByLabelText('What is it?')).toHaveFocus()
  })

  it('cycles backwards from the first control to the last', async () => {
    await openCapture()

    await userEvent.tab({ shift: true })

    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
  })

  it('never lands on a control behind the dialog', async () => {
    await openCapture()

    for (let presses = 0; presses < 12; presses += 1) {
      await userEvent.tab()
      expect(screen.getByRole('button', { name: 'Background control' })).not.toHaveFocus()
      expect(screen.getByRole('button', { name: 'Quick capture' })).not.toHaveFocus()
    }
  })
})

/**
 * Quick capture is reachable the moment the app is authenticated, from the header button or the
 * `c` shortcut, independent of the board's own `loading` state. That means it can be open and
 * typed into before `GET /api/config` has answered and `timezone` is still the UTC default, and
 * a date set in that window must not be silently resolved against UTC instead of the deployment's
 * real zone once it is known.
 */
describe('the gap before the deployment’s configured timezone has loaded', () => {
  /** Flips from the unresolved default to a real, non-UTC zone on demand, the way `useCarolineData`
   *  does once `GET /api/config` answers. */
  function RaceHarness({ onCreate }: { onCreate: (input: unknown) => Promise<boolean> }) {
    const [open, setOpen] = useState(false)
    const [configLoaded, setConfigLoaded] = useState(false)
    const [timezone, setTimezone] = useState('UTC')

    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Quick capture
        </button>
        <button
          type="button"
          onClick={() => {
            setTimezone('Europe/London')
            setConfigLoaded(true)
          }}
        >
          Resolve config
        </button>
        <QuickCapture
          open={open}
          projects={[]}
          timezone={timezone}
          configLoaded={configLoaded}
          onClose={() => setOpen(false)}
          onCreate={onCreate}
        />
      </>
    )
  }

  it('disables the due and defer-until fields until config has loaded, then resolves a date typed afterwards against the real zone rather than the stale UTC default', async () => {
    const onCreate = vi.fn(async () => true)
    render(<RaceHarness onCreate={onCreate} />)
    await userEvent.click(screen.getByRole('button', { name: 'Quick capture' }))

    // The race window: the dialog is open and interactive, but config has not answered yet.
    expect(screen.getByLabelText('Due')).toBeDisabled()
    expect(screen.getByLabelText('Defer until')).toBeDisabled()

    // Config answers with the deployment's real, non-UTC zone.
    await userEvent.click(screen.getByRole('button', { name: 'Resolve config' }))
    expect(screen.getByLabelText('Due')).toBeEnabled()

    await userEvent.type(screen.getByLabelText('What is it?'), 'Renew the domain')
    fireEvent.change(screen.getByLabelText('Due'), { target: { value: '2026-07-01' } })
    await userEvent.click(screen.getByRole('button', { name: 'Capture' }))

    expect(onCreate).toHaveBeenCalledWith({
      title: 'Renew the domain',
      dueAt: dueAtFromDateInput('2026-07-01', 'Europe/London'),
    })
  })
})

describe('capturing', () => {
  it('sends the trimmed title, the notes and the project', async () => {
    const onCreate = await openCapture()

    await userEvent.type(screen.getByLabelText('What is it?'), '  Renew the domain  ')
    await userEvent.type(screen.getByLabelText('Notes'), 'Before it lapses')
    await userEvent.selectOptions(screen.getByLabelText('Project'), 'project-1')
    await userEvent.click(screen.getByRole('button', { name: 'Capture' }))

    expect(onCreate).toHaveBeenCalledWith({
      title: 'Renew the domain',
      notes: 'Before it lapses',
      projectId: 'project-1',
    })
  })

  /**
   * A native date input rather than free text: the board and the card both already read a due
   * date and a defer-until date as a local day, so capture sets them the same way it displays
   * them. Criterion 18 and the surrounding text in spec 08.
   */
  it('sends a due date and a defer-until date as the end and the start of the days given', async () => {
    const onCreate = await openCapture()

    await userEvent.type(screen.getByLabelText('What is it?'), 'Renew the domain')
    fireEvent.change(screen.getByLabelText('Due'), { target: { value: '2026-07-01' } })
    fireEvent.change(screen.getByLabelText('Defer until'), { target: { value: '2026-06-20' } })
    await userEvent.click(screen.getByRole('button', { name: 'Capture' }))

    expect(onCreate).toHaveBeenCalledWith({
      title: 'Renew the domain',
      dueAt: dueAtFromDateInput('2026-07-01', 'UTC'),
      deferUntil: deferUntilFromDateInput('2026-06-20', 'UTC'),
    })
  })

  it('does not send a due date or a defer-until date when neither is set', async () => {
    const onCreate = await openCapture()

    await userEvent.type(screen.getByLabelText('What is it?'), 'Renew the domain')
    await userEvent.click(screen.getByRole('button', { name: 'Capture' }))

    expect(onCreate).toHaveBeenCalledWith({ title: 'Renew the domain' })
  })

  it('clears the dates it did send, so the next capture starts with neither set', async () => {
    await openCapture()

    await userEvent.type(screen.getByLabelText('What is it?'), 'Renew the domain')
    fireEvent.change(screen.getByLabelText('Due'), { target: { value: '2026-07-01' } })
    await userEvent.click(screen.getByRole('button', { name: 'Capture' }))
    await userEvent.click(screen.getByRole('button', { name: 'Quick capture' }))

    expect(screen.getByLabelText('Due')).toHaveValue('')
  })

  it('closes once the task has been created', async () => {
    await openCapture()

    await userEvent.type(screen.getByLabelText('What is it?'), 'Renew the domain')
    await userEvent.click(screen.getByRole('button', { name: 'Capture' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  /** The alert says what went wrong; only the form still holding the text makes that useful. */
  it('stays open with the text intact when the write is refused', async () => {
    await openCapture(vi.fn(async () => false))

    await userEvent.type(screen.getByLabelText('What is it?'), 'Renew the domain')
    await userEvent.type(screen.getByLabelText('Notes'), 'Before it lapses')
    await userEvent.click(screen.getByRole('button', { name: 'Capture' }))

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByLabelText('What is it?')).toHaveValue('Renew the domain')
    expect(screen.getByLabelText('Notes')).toHaveValue('Before it lapses')
  })

  it('will not capture an empty title', async () => {
    await openCapture()

    expect(screen.getByRole('button', { name: 'Capture' })).toBeDisabled()
  })

  /**
   * The fields stay editable while the request is out, so anything typed in that window belongs
   * to the next capture. Clearing it would be a silent loss.
   */
  it('keeps a title typed while the first capture was in flight', async () => {
    let release: (created: boolean) => void = () => {}
    const onCreate = vi.fn(() => new Promise<boolean>((resolve) => (release = resolve)))
    await openCapture(onCreate)

    await userEvent.type(screen.getByLabelText('What is it?'), 'First thing')
    await userEvent.click(screen.getByRole('button', { name: 'Capture' }))
    await userEvent.clear(screen.getByLabelText('What is it?'))
    await userEvent.type(screen.getByLabelText('What is it?'), 'Second thing')
    release(true)

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: 'Quick capture' }))
    expect(screen.getByLabelText('What is it?')).toHaveValue('Second thing')
  })

  it('clears the fields it did send, so the next capture starts empty', async () => {
    await openCapture()

    await userEvent.type(screen.getByLabelText('What is it?'), 'Renew the domain')
    await userEvent.click(screen.getByRole('button', { name: 'Capture' }))
    await userEvent.click(screen.getByRole('button', { name: 'Quick capture' }))

    expect(screen.getByLabelText('What is it?')).toHaveValue('')
  })

  /** The prop is a promise, so a caller that rejects must not disable the button for good. */
  it('can be tried again after the create rejects rather than resolving', async () => {
    await openCapture(
      vi.fn(async () => {
        throw new Error('the network went away')
      }),
    )

    await userEvent.type(screen.getByLabelText('What is it?'), 'Renew the domain')
    await userEvent.click(screen.getByRole('button', { name: 'Capture' }))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Capture' })).toBeEnabled())
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  /**
   * A capture can still be in flight when the dialog is closed. Its result then belongs to a
   * session that is over, and closing on it would take away the capture being typed now.
   */
  it('does not close a reopened dialog when an earlier capture resolves', async () => {
    let release: (created: boolean) => void = () => {}
    const onCreate = vi.fn(() => new Promise<boolean>((resolve) => (release = resolve)))
    await openCapture(onCreate)

    await userEvent.type(screen.getByLabelText('What is it?'), 'First thing')
    await userEvent.click(screen.getByRole('button', { name: 'Capture' }))
    await userEvent.keyboard('{Escape}')
    await userEvent.click(screen.getByRole('button', { name: 'Quick capture' }))
    await userEvent.type(screen.getByLabelText('What is it?'), 'Second thing')

    release(true)
    await act(async () => {})

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByLabelText('What is it?')).toHaveValue('Second thing')
  })

  /**
   * Closing empties the fields, so a capture abandoned mid-flight leaves nothing behind for the
   * next one to send a second time. It is `close` that does this, not the request's own result.
   */
  it('starts empty after a capture was abandoned mid-flight', async () => {
    let release: (created: boolean) => void = () => {}
    const onCreate = vi.fn(() => new Promise<boolean>((resolve) => (release = resolve)))
    await openCapture(onCreate)

    await userEvent.type(screen.getByLabelText('What is it?'), 'First thing')
    await userEvent.click(screen.getByRole('button', { name: 'Capture' }))
    await userEvent.keyboard('{Escape}')

    release(true)
    await act(async () => {})

    await userEvent.click(screen.getByRole('button', { name: 'Quick capture' }))
    expect(screen.getByLabelText('What is it?')).toHaveValue('')
  })

  /**
   * The hard case for the clearing rule: the new session happens to hold the same text as the
   * old request sent. Matching text is not the same text, and a result from a session that is
   * over has no business touching the one that is open.
   */
  it('leaves identical text in a new session alone when an old capture resolves', async () => {
    let release: (created: boolean) => void = () => {}
    const onCreate = vi.fn(() => new Promise<boolean>((resolve) => (release = resolve)))
    await openCapture(onCreate)

    await userEvent.type(screen.getByLabelText('What is it?'), 'Same title')
    await userEvent.click(screen.getByRole('button', { name: 'Capture' }))
    await userEvent.keyboard('{Escape}')
    await userEvent.click(screen.getByRole('button', { name: 'Quick capture' }))
    await userEvent.type(screen.getByLabelText('What is it?'), 'Same title')

    release(true)
    await act(async () => {})

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByLabelText('What is it?')).toHaveValue('Same title')
  })

  /**
   * `saving` is one flag for a component that outlives its dialog, so it has an owner: the
   * session that set it. A request from a closed session must neither block the new dialog's
   * Capture button nor, once this is fixed, re-enable it while the new session's own request is
   * still out, which would send that one twice.
   */
  describe('a request left over from a closed session', () => {
    /** Hands back a resolver per call, so two captures can be in flight at once. */
    function pendingCreates() {
      const resolvers: Array<(created: boolean) => void> = []
      const onCreate = vi.fn(() => new Promise<boolean>((resolve) => resolvers.push(resolve)))

      return { onCreate, resolvers }
    }

    it('does not leave Capture disabled in the dialog that opens next', async () => {
      const { onCreate } = pendingCreates()
      await openCapture(onCreate)

      await userEvent.type(screen.getByLabelText('What is it?'), 'First thing')
      await userEvent.click(screen.getByRole('button', { name: 'Capture' }))
      await userEvent.keyboard('{Escape}')
      await userEvent.click(screen.getByRole('button', { name: 'Quick capture' }))
      await userEvent.type(screen.getByLabelText('What is it?'), 'Second thing')

      expect(screen.getByRole('button', { name: 'Capture' })).toBeEnabled()
    })

    it('cannot re-enable Capture while this session is still saving', async () => {
      const { onCreate, resolvers } = pendingCreates()
      await openCapture(onCreate)

      await userEvent.type(screen.getByLabelText('What is it?'), 'First thing')
      await userEvent.click(screen.getByRole('button', { name: 'Capture' }))
      await userEvent.keyboard('{Escape}')
      await userEvent.click(screen.getByRole('button', { name: 'Quick capture' }))
      await userEvent.type(screen.getByLabelText('What is it?'), 'Second thing')
      await userEvent.click(screen.getByRole('button', { name: 'Capture' }))
      expect(onCreate).toHaveBeenCalledTimes(2)

      // The first request lands while the second is still out.
      resolvers[0]?.(true)
      await act(async () => {})

      expect(screen.getByRole('button', { name: 'Capture' })).toBeDisabled()
      await userEvent.click(screen.getByRole('button', { name: 'Capture' }))
      expect(onCreate).toHaveBeenCalledTimes(2)
    })
  })

  it('does not send the same capture twice while the first is in flight', async () => {
    let release = () => {}
    const onCreate = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = () => resolve(true)
        }),
    )
    await openCapture(onCreate)

    await userEvent.type(screen.getByLabelText('What is it?'), 'Renew the domain')
    await userEvent.click(screen.getByRole('button', { name: 'Capture' }))
    await userEvent.click(screen.getByRole('button', { name: 'Capture' }))

    expect(onCreate).toHaveBeenCalledTimes(1)
    release()
  })
})

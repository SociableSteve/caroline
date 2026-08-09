/**
 * Quick capture's modal contract. `aria-modal="true"` tells a screen reader the rest of the
 * page is inert, so Tab has to agree with it, and closing has to give the focus back to
 * whatever opened it. Not borrowed from `<dialog>`, therefore tested here.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { useState } from 'react'
import { QuickCapture } from './components/QuickCapture.js'
import { aProject } from './test-fixtures.js'

/** The dialog as the app uses it: something focusable outside it, and an opener button. */
function Harness({ onCreate }: { onCreate: (input: unknown) => Promise<boolean> }) {
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
        onClose={() => setOpen(false)}
        onCreate={onCreate}
      />
    </>
  )
}

async function openCapture(onCreate = vi.fn(async () => true)) {
  render(<Harness onCreate={onCreate} />)
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

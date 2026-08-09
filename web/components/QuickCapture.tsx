/**
 * Quick capture: reachable from anywhere, creates an inbox task, and gets out of the way.
 * Spec 08, interaction rules.
 *
 * Not a `<dialog>`: `showModal` brings behaviour that has to be worked around as often as it
 * is used, and jsdom does not implement it, so the modal contract would go untested. Taking
 * that route means owning the contract instead of borrowing it, which is what the focus trap
 * and the focus restoration below are: `aria-modal="true"` tells a screen reader the rest of
 * the page is inert, and Tab has to agree with it.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { ProjectView, TaskInput } from '../api.js'

export interface QuickCaptureProps {
  readonly open: boolean
  readonly projects: readonly ProjectView[]
  readonly onClose: () => void
  /** Answers whether the task was created. The form holds what was typed until it was. */
  readonly onCreate: (input: TaskInput) => Promise<boolean>
}

const FOCUSABLE = 'input, textarea, select, button:not([disabled]), [href]'

export function QuickCapture({ open, projects, onClose, onCreate }: QuickCaptureProps) {
  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')
  const [projectId, setProjectId] = useState('')
  const [saving, setSaving] = useState(false)
  const dialog = useRef<HTMLElement>(null)
  const titleField = useRef<HTMLInputElement>(null)
  /** Whatever had the focus when this opened, so closing can give it back. */
  const opener = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return

    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    // Opening puts the caret in the title, which is the only reason to have opened it.
    titleField.current?.focus()

    return () => {
      // The opener can have gone away while the dialog was up, hence the guard.
      if (opener.current?.isConnected === true) opener.current.focus()
    }
  }, [open])

  if (!open) return null

  const close = () => {
    setTitle('')
    setNotes('')
    setProjectId('')
    onClose()
  }

  /**
   * Clears only what was actually sent. The fields stay editable while the request is out, and
   * text typed in that window belongs to the next capture rather than to this one, so a blanket
   * reset would throw it away.
   */
  const closeKeeping = (sent: { title: string; notes: string; projectId: string }) => {
    setTitle((current) => (current === sent.title ? '' : current))
    setNotes((current) => (current === sent.notes ? '' : current))
    setProjectId((current) => (current === sent.projectId ? '' : current))
    onClose()
  }

  const submit = async () => {
    const sent = { title, notes, projectId }
    const trimmed = sent.title.trim()
    if (trimmed === '' || saving) return

    setSaving(true)
    let created = false
    try {
      created = await onCreate({
        title: trimmed,
        ...(sent.notes.trim() === '' ? {} : { notes: sent.notes.trim() }),
        ...(sent.projectId === '' ? {} : { projectId: sent.projectId }),
      })
    } catch {
      // A rejection is a capture that did not happen, which is what `false` already means, so
      // it is handled the same way: the dialog stays open with the text in it. Swallowed rather
      // than rethrown, since there is nowhere for it to go from a form submit, and reporting the
      // reason is the caller's job.
      created = false
    } finally {
      // In a `finally`, so neither path can leave the Capture button disabled for as long as
      // the dialog is open.
      setSaving(false)
    }

    // Only on success. A rejected write leaves the dialog open with the text still in it, so
    // the failure costs a second attempt rather than the typing.
    if (created) closeKeeping(sent)
  }

  /**
   * Tab cycles within the dialog rather than walking off into content that `aria-modal` has
   * just declared inert.
   */
  const trapFocus = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Tab') return

    const focusable = Array.from(dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (first === undefined || last === undefined) return

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <div
      className="capture-backdrop"
      onKeyDown={(event) => {
        if (event.key === 'Escape') close()
        else trapFocus(event)
      }}
    >
      <section
        className="capture"
        role="dialog"
        aria-modal="true"
        aria-labelledby="capture-heading"
        ref={dialog}
      >
        <h2 id="capture-heading">Quick capture</h2>

        <form
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <label>
            What is it?
            <input
              ref={titleField}
              name="title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              autoComplete="off"
            />
          </label>

          <label>
            Notes
            <textarea
              name="notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              rows={3}
            />
          </label>

          <label>
            Project
            <select
              name="projectId"
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
            >
              <option value="">No project</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.title}
                </option>
              ))}
            </select>
          </label>

          <p className="capture-hint">It lands in the inbox, to be triaged later.</p>

          <div className="capture-actions">
            <button type="submit" disabled={title.trim() === '' || saving}>
              Capture
            </button>
            <button type="button" onClick={close}>
              Cancel
            </button>
          </div>
        </form>
      </section>
    </div>
  )
}

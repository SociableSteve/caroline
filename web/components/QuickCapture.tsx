/**
 * Quick capture: reachable from anywhere, creates an inbox task, and gets out of the way.
 * Spec 08, interaction rules.
 *
 * Not a `<dialog>`: `showModal` is where a browser's own focus trap lives, and the element
 * brings behaviour that has to be worked around as often as it is used. A labelled region
 * with the focus moved into it and Escape wired up is the whole contract here.
 */
import { useEffect, useRef, useState } from 'react'
import type { ProjectView, TaskInput } from '../api.js'

export interface QuickCaptureProps {
  readonly open: boolean
  readonly projects: readonly ProjectView[]
  readonly onClose: () => void
  readonly onCreate: (input: TaskInput) => void
}

export function QuickCapture({ open, projects, onClose, onCreate }: QuickCaptureProps) {
  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')
  const [projectId, setProjectId] = useState('')
  const titleField = useRef<HTMLInputElement>(null)

  // Opening puts the caret in the title, which is the only reason to have opened it.
  useEffect(() => {
    if (open) titleField.current?.focus()
  }, [open])

  if (!open) return null

  const close = () => {
    setTitle('')
    setNotes('')
    setProjectId('')
    onClose()
  }

  const submit = () => {
    const trimmed = title.trim()
    if (trimmed === '') return

    onCreate({
      title: trimmed,
      ...(notes.trim() === '' ? {} : { notes: notes.trim() }),
      ...(projectId === '' ? {} : { projectId }),
    })
    close()
  }

  return (
    <div className="capture-backdrop" onKeyDown={(event) => event.key === 'Escape' && close()}>
      <section
        className="capture"
        role="dialog"
        aria-modal="true"
        aria-labelledby="capture-heading"
      >
        <h2 id="capture-heading">Quick capture</h2>

        <form
          onSubmit={(event) => {
            event.preventDefault()
            submit()
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
            <button type="submit" disabled={title.trim() === ''}>
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

/**
 * Quick capture: reachable from anywhere, creates an inbox task, and gets out of the way.
 * Spec 08, interaction rules.
 *
 * Built on shadcn/ui's `Dialog` (Radix underneath), which owns the focus trap, the Escape
 * handling and the focus restoration this component used to hand-roll: Radix's contract is the
 * one being borrowed now rather than one this file owns itself.
 */
import { useEffect, useRef, useState } from 'react'
import type { ProjectView, TaskInput } from '../api.js'
import { deferUntilFromDateInput, dueAtFromDateInput } from '../format.js'
import { ActionRow, Field } from './primitives.js'
import { Button } from './ui/button.js'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog.js'
import { Input } from './ui/input.js'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select.js'
import { Textarea } from './ui/textarea.js'

export interface QuickCaptureProps {
  readonly open: boolean
  readonly projects: readonly ProjectView[]
  /** The zone the due and defer-until fields resolve a typed date in, so a date set here lands
   *  on the same instant it would from chat. Spec 06. */
  readonly timezone: string
  /** Whether `timezone` is the deployment's real configured zone yet, rather than the UTC
   *  default it starts as. Quick capture is reachable from anywhere the moment the app is
   *  authenticated, independent of the board's own `loading` state, so its due and defer-until
   *  fields are disabled until this is true rather than risk a date silently resolved against
   *  the wrong zone. */
  readonly configLoaded: boolean
  readonly onClose: () => void
  /** Answers whether the task was created. The form holds what was typed until it was. */
  readonly onCreate: (input: TaskInput) => Promise<boolean>
}

const NO_PROJECT = 'none'

export function QuickCapture({
  open,
  projects,
  timezone,
  configLoaded,
  onClose,
  onCreate,
}: QuickCaptureProps) {
  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')
  const [projectId, setProjectId] = useState('')
  /** Empty means unset. A native date input's own value is already the local `YYYY-MM-DD` the
   *  API's fields are built from, so nothing else is kept for these two. */
  const [dueDate, setDueDate] = useState('')
  const [deferDate, setDeferDate] = useState('')
  const [saving, setSaving] = useState(false)
  /**
   * Which opening of the dialog this is. A capture can still be in flight when the dialog is
   * closed, and its result then belongs to a session that is over: acting on it would close the
   * next one out from under whoever is typing into it.
   */
  /**
   * Which opening of the dialog this is. A `ref` and not `useState`: a request in flight reads
   * this again after `await`ing, to find out whether it is still the session that started it, and
   * a value closed over at render time could never tell it that a later render moved on.
   */
  const session = useRef(0)
  /** Whatever had the focus when this opened, so closing can give it back. Radix's own default
   *  restores focus to a `Dialog.Trigger`, and this dialog is reachable from more than one place
   *  (the header button, the `c` shortcut), so there is no single trigger to wire one to. */
  const opener = useRef<HTMLElement | null>(null)

  const reset = () => {
    setTitle('')
    setNotes('')
    setProjectId('')
    setDueDate('')
    setDeferDate('')
  }

  useEffect(() => {
    if (!open) return

    session.current += 1
    // A request from a previous session may still be out, and its pending state is not this
    // session's business: leaving it set would open the dialog with Capture disabled and no
    // explanation for it.
    setSaving(false)
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
  }, [open])

  /**
   * Clears only what was actually sent. The fields stay editable while the request is out, and
   * text typed in that window belongs to the next capture rather than to this one, so a blanket
   * reset would throw it away.
   */
  const clearSent = (sent: {
    title: string
    notes: string
    projectId: string
    dueDate: string
    deferDate: string
  }) => {
    setTitle((current) => (current === sent.title ? '' : current))
    setNotes((current) => (current === sent.notes ? '' : current))
    setProjectId((current) => (current === sent.projectId ? '' : current))
    setDueDate((current) => (current === sent.dueDate ? '' : current))
    setDeferDate((current) => (current === sent.deferDate ? '' : current))
  }

  const submit = async () => {
    const sent = { title, notes, projectId, dueDate, deferDate }
    const mine = session.current
    const trimmed = sent.title.trim()
    if (trimmed === '' || saving) return

    // Null means the typed date could not be resolved to an instant in `timezone` at all, which
    // no real IANA zone does for a whole calendar day: the field is left off rather than sent
    // as a guess, the same as if nothing had been typed.
    const dueAt = sent.dueDate === '' ? null : dueAtFromDateInput(sent.dueDate, timezone)
    const deferUntil =
      sent.deferDate === '' ? null : deferUntilFromDateInput(sent.deferDate, timezone)

    setSaving(true)
    let created = false
    try {
      created = await onCreate({
        title: trimmed,
        ...(sent.notes.trim() === '' ? {} : { notes: sent.notes.trim() }),
        ...(sent.projectId === '' ? {} : { projectId: sent.projectId }),
        ...(dueAt === null ? {} : { dueAt }),
        ...(deferUntil === null ? {} : { deferUntil }),
      })
    } catch {
      // A rejection is a capture that did not happen, which is what `false` already means, so
      // it is handled the same way: the dialog stays open with the text in it. Swallowed rather
      // than rethrown, since there is nowhere for it to go from a form submit, and reporting the
      // reason is the caller's job.
      created = false
    } finally {
      // In a `finally`, so neither a refusal nor a rejection can leave Capture disabled for as
      // long as the dialog is open. Only for the session that started it, though: a stale
      // request clearing the flag would re-enable Capture while this session's own request is
      // still out, and the second press would send it twice.
      if (mine === session.current) setSaving(false)
    }

    // Only on success. A rejected write leaves the dialog open with the text still in it, so
    // the failure costs a second attempt rather than the typing.
    if (!created) return

    // A result from a session that is over changes nothing here. Closing it would take away the
    // capture being typed now, and clearing it would be no safer: `reset` empties the fields on
    // the way out, so whatever is in them belongs to the session that is open, even when it
    // happens to read the same as what was sent.
    if (mine !== session.current) return

    clearSent(sent)
    onClose()
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          reset()
          onClose()
        }
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        onCloseAutoFocus={(event) => {
          // Radix's own default only knows how to return focus to a `Dialog.Trigger`; this
          // dialog has no single one, so it takes over with the opener it recorded itself.
          event.preventDefault()
          if (opener.current?.isConnected === true) opener.current.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-sm font-semibold">Quick capture</DialogTitle>
        </DialogHeader>

        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <Field label="What is it?" className="text-[11px] text-muted-foreground">
            <Input
              className="w-full text-[13px]"
              name="title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              autoComplete="off"
              autoFocus
            />
          </Field>

          <Field label="Notes" className="text-[11px] text-muted-foreground">
            <Textarea
              className="w-full resize-none text-[13px]"
              name="notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              rows={3}
            />
          </Field>

          <Field label="Project" className="text-[11px] text-muted-foreground">
            <Select
              value={projectId === '' ? NO_PROJECT : projectId}
              onValueChange={(value) => setProjectId(value === NO_PROJECT ? '' : value)}
            >
              <SelectTrigger className="w-full text-[13px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_PROJECT}>No project</SelectItem>
                {projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label="Due" className="text-[11px] text-muted-foreground">
            <Input
              className="w-full text-[13px]"
              type="date"
              name="dueAt"
              value={dueDate}
              onChange={(event) => setDueDate(event.target.value)}
              disabled={!configLoaded}
              title={
                configLoaded
                  ? undefined
                  : 'Waiting for the deployment’s configured timezone to load'
              }
            />
          </Field>

          <Field label="Defer until" className="text-[11px] text-muted-foreground">
            <Input
              className="w-full text-[13px]"
              type="date"
              name="deferUntil"
              value={deferDate}
              onChange={(event) => setDeferDate(event.target.value)}
              disabled={!configLoaded}
              title={
                configLoaded
                  ? undefined
                  : 'Waiting for the deployment’s configured timezone to load'
              }
            />
          </Field>

          <p className="m-0 text-[11px] text-muted-foreground">
            It lands in the inbox, to be triaged later.
          </p>

          <ActionRow>
            <Button
              type="submit"
              variant="default"
              size="sm"
              className="h-8 px-3.5 text-xs"
              disabled={title.trim() === '' || saving}
            >
              Capture
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 px-3.5 text-xs text-muted-foreground"
              onClick={onClose}
            >
              Cancel
            </Button>
          </ActionRow>
        </form>
      </DialogContent>
    </Dialog>
  )
}

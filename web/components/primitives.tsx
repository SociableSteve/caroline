/**
 * The five primitives of spec 10, rebuilt on shadcn/ui's generated components. Each owns a pattern
 * that was being rewritten per surface: a titled region, a label-and-value grid, a state said in
 * words, a labelled control, and a row of actions. A surface composes these; it does not restyle
 * them, which is what keeps the surfaces and the chat rail reading as one system.
 *
 * They live here, in this application's own directory, and they take the props this application
 * needs. There is no package and no case handled that does not occur.
 */
import { useId, type DragEvent, type ReactNode } from 'react'
import { cn } from '../lib/utils.js'
import { Card, CardContent, CardHeader } from './ui/card.js'
import { BadgeUi } from './ui/badge.js'
import { LabelUi } from './ui/label.js'

/** The one appearance a failure or a stale-data warning takes anywhere in the app: a bordered,
 *  destructive-tinted block. Shared as a class string rather than a component, since the callers
 *  differ in which role (`alert` or `status`) the text carries. */
export const failureClassName =
  'rounded-sm border border-destructive bg-destructive/10 px-4 py-3 text-destructive'

/** A title that opens an item in the rail: a plain `<button>` reset to read as text, underlining
 *  only on hover, so the thing being pointed at is the thing that responds. Shared as a class
 *  string, since a task card and a plan entry both need it and neither is `Button`: this opens a
 *  read, not an action, and looking like every other filled or outlined control would say
 *  otherwise. */
/** An empty state's own line: italic, quiet text, so it never reads as a heading or a value.
 *  Shared as a class string, since it decorates a plain `<p>` on a dozen different surfaces
 *  rather than a component of its own. */
export const emptyClassName = 'italic text-muted-foreground'

/** A quiet aside beside or below the thing it annotates: an "undone" marker, a token count, an
 *  approval date. Shared as a class string across the rail, the details panel and settings. */
export const changeNoteClassName = 'text-[11px] text-muted-foreground'

/** A policy explanation, the same quiet, small text as a change note, kept as its own name because
 *  the two read differently even though they share an appearance: a change note annotates an
 *  event, a policy note explains a rule. */
export const policyNoteClassName = 'text-[11px] text-muted-foreground'

/** A raw payload, quoted verbatim: a sunk, scrollable block in the mono type the rest of the app
 *  reserves for times, counts and cron lines. Shared across the rail's turn context, Settings'
 *  policy previews and QuickCapture's proposal payloads. */
export const payloadPreviewClassName =
  'mb-3 overflow-x-auto whitespace-pre-wrap rounded-md border bg-background p-3 font-mono text-[11px] leading-relaxed'

export const itemOpenClassName =
  'cursor-pointer border-0 bg-transparent p-0 text-left text-inherit [font:inherit] hover:underline'

export interface PanelProps {
  readonly heading: ReactNode
  /**
   * The caller's, because the heading outline belongs to the surface rather than to the
   * component: a surface opens with its own `h1` and its panels are `h2` beneath it.
   */
  readonly headingLevel: 2 | 3
  readonly children: ReactNode
  readonly className?: string | undefined
  readonly headingClassName?: string | undefined
  /**
   * An accessible name for the region where the heading is not the whole of it. The board's
   * columns are the case: the heading carries a digit and a count that read as noise in a name.
   */
  readonly label?: string | undefined
  readonly onDragOver?: ((event: DragEvent<HTMLElement>) => void) | undefined
  readonly onDrop?: ((event: DragEvent<HTMLElement>) => void) | undefined
}

/**
 * A titled region: shadcn's `Card`, on this design's own panel ground rather than the raised card
 * ground a `Card` gets elsewhere (a task card, a chat turn), padded and radiused per spec 10. No
 * border: the ground is what says where it is, and an outline around a region that already has a
 * ground is the habit this milestone exists to break.
 */
export function Panel({
  heading,
  headingLevel,
  children,
  className,
  headingClassName,
  label,
  onDragOver,
  onDrop,
}: PanelProps) {
  const headingId = useId()
  const Heading = headingLevel === 2 ? 'h2' : 'h3'

  return (
    <Card
      as="section"
      className={cn('panel p-3', className)}
      {...(label === undefined ? { 'aria-labelledby': headingId } : { 'aria-label': label })}
      {...(onDragOver === undefined ? {} : { onDragOver })}
      {...(onDrop === undefined ? {} : { onDrop })}
    >
      <CardHeader className="m-0">
        <Heading
          id={headingId}
          className={
            headingClassName === undefined ? 'm-0 mb-2 text-lg font-normal' : headingClassName
          }
        >
          {heading}
        </Heading>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

/**
 * The label-and-value grid the task card, the job panel and the settings policy each built for
 * themselves. One implementation, three callers. No shadcn equivalent: this is a plain `<dl>`,
 * restyled with Tailwind's grid utilities rather than the hand-written `.facts` rule it replaces.
 */
export function Facts({
  children,
  className,
}: {
  readonly children: ReactNode
  readonly className?: string | undefined
}) {
  return (
    <dl
      className={cn(
        'facts m-0 mb-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 [&_dt]:text-[11px] [&_dt]:text-muted-foreground [&_dd]:m-0 [&_dd]:min-w-0 [&_dd]:text-[11px] [&_dd]:[overflow-wrap:anywhere]',
        className,
      )}
    >
      {children}
    </dl>
  )
}

/** One row of a `Facts` grid. A fragment, so the grid's own columns stay the columns. */
export function Fact({
  label,
  children,
  className,
}: {
  readonly label: ReactNode
  readonly children: ReactNode
  readonly className?: string | undefined
}) {
  return (
    <>
      <dt>{label}</dt>
      <dd {...(className === undefined ? {} : { className })}>{children}</dd>
    </>
  )
}

/**
 * A short state, in words, outlined in the colour that state calls for. A badge never abbreviates
 * to a colour alone and never carries a tooltip as its only text. Built on shadcn's `Badge`
 * pattern (`ui/badge.js`), carrying the literal `badge`/`badge-<tone>` classes too: nothing else in
 * the codebase styles from them any more, but `design-system.test.tsx` still selects surfaces'
 * badges by them, and callers of this component are free to.
 */
export function Badge({
  tone = 'quiet',
  children,
  className,
}: {
  readonly tone?: 'quiet' | 'accent' | 'alarm'
  readonly children: ReactNode
  readonly className?: string | undefined
}) {
  return (
    <BadgeUi variant={tone} className={cn('badge', `badge-${tone}`, className)}>
      {children}
    </BadgeUi>
  )
}

/**
 * A label above its control, wired together by wrapping. Every form on every surface uses it, so
 * there is one answer to where a label sits. Built on shadcn's `Label` (`ui/label.js`, Radix
 * underneath), which still renders a real `<label>` and still wraps its control, so every existing
 * caller's markup and behaviour are unchanged.
 */
export function Field({
  label,
  children,
  hiddenLabel = false,
  className,
}: {
  readonly label: ReactNode
  readonly children: ReactNode
  /** For a control whose purpose the surrounding text already gives, such as a card's status. */
  readonly hiddenLabel?: boolean
  readonly className?: string | undefined
}) {
  return (
    <LabelUi className={cn('field inline-flex', className)}>
      <span className={hiddenLabel ? 'sr-only' : undefined}>{label}</span>
      {children}
    </LabelUi>
  )
}

/**
 * A row of controls with the primary action first, which wraps without changing the order. Where
 * the row would not fit, the secondary controls move behind a disclosure rather than onto a second
 * line: see the task card. Plain Tailwind utilities on a `<div>`: shadcn has no component for a
 * layout row, and none is needed.
 */
export function ActionRow({
  children,
  className,
}: {
  readonly children: ReactNode
  readonly className?: string | undefined
}) {
  return (
    <div className={cn('action-row flex flex-wrap items-end gap-2', className)}>{children}</div>
  )
}

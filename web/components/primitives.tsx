/**
 * The five primitives of spec 10. Each owns a pattern that was being rewritten per surface: a
 * titled region, a label-and-value grid, a state said in words, a labelled control, and a row of
 * actions. A surface composes these; it does not restyle them, which is what keeps six surfaces
 * reading as one system.
 *
 * They live here, in this application's own directory, and they take the props this application
 * needs. There is no package and no case handled that does not occur.
 */
import { useId, type ReactNode } from 'react'

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
  readonly onDragOver?: ((event: React.DragEvent<HTMLElement>) => void) | undefined
  readonly onDrop?: ((event: React.DragEvent<HTMLElement>) => void) | undefined
}

/** A titled region: the ground, the border, the radius and the padding, in one place. */
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
    <section
      className={className === undefined ? 'panel' : `panel ${className}`}
      {...(label === undefined ? { 'aria-labelledby': headingId } : { 'aria-label': label })}
      {...(onDragOver === undefined ? {} : { onDragOver })}
      {...(onDrop === undefined ? {} : { onDrop })}
    >
      <Heading
        id={headingId}
        className={headingClassName === undefined ? 'panel-heading' : headingClassName}
      >
        {heading}
      </Heading>
      {children}
    </section>
  )
}

/**
 * The label-and-value grid the task card, the job panel and the settings policy each built for
 * themselves. One implementation, three callers.
 */
export function Facts({
  children,
  className,
}: {
  readonly children: ReactNode
  readonly className?: string | undefined
}) {
  return <dl className={className === undefined ? 'facts' : `facts ${className}`}>{children}</dl>
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
 * to a colour alone and never carries a tooltip as its only text.
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
    <span className={`badge badge-${tone}${className === undefined ? '' : ` ${className}`}`}>
      {children}
    </span>
  )
}

/**
 * A label above its control, wired together by wrapping. Every form on every surface uses it, so
 * there is one answer to where a label sits.
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
    <label className={className === undefined ? 'field' : `field ${className}`}>
      <span className={hiddenLabel ? 'visually-hidden' : undefined}>{label}</span>
      {children}
    </label>
  )
}

/**
 * A row of controls with the primary action first, which wraps without changing the order. Where
 * the row would not fit, the secondary controls move behind a disclosure rather than onto a second
 * line: see the task card.
 */
export function ActionRow({
  children,
  className,
}: {
  readonly children: ReactNode
  readonly className?: string | undefined
}) {
  return (
    <div className={className === undefined ? 'action-row' : `action-row ${className}`}>
      {children}
    </div>
  )
}

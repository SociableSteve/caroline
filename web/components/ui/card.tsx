/**
 * shadcn/ui's generated Card, hand-vendored (see button.tsx for why) and pared to the pieces this
 * app's `Panel` primitive (`../primitives.js`) actually composes: no surface reaches for `Card`
 * directly, and the heading is Panel's own `<h2>`/`<h3>`, not a fixed `CardTitle` tag.
 */
import type { ComponentProps, ElementType } from 'react'
import { cn } from '../../lib/utils.js'

export interface CardProps extends ComponentProps<'div'> {
  /** The element Card renders as. `Panel` (`../primitives.js`) asks for `section`, so a titled
   *  region keeps the implicit `region` role its `aria-label`/`aria-labelledby` needs; a plain
   *  `<div>` carries no landmark role regardless of those attributes. */
  readonly as?: ElementType
}

export function Card({ className, as: Tag = 'div', ...props }: CardProps) {
  return <Tag className={cn('rounded-md bg-card text-card-foreground', className)} {...props} />
}

export function CardHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('mb-2', className)} {...props} />
}

export function CardContent({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex min-h-0 flex-1 flex-col', className)} {...props} />
}

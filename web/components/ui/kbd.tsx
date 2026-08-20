/**
 * shadcn/ui's generated Kbd, hand-vendored (see button.tsx for why): a single key or chord,
 * rendered in the mono type the rest of the app already reserves for times, counts and cron
 * lines. Used in place of a raw `<kbd>` tag wherever the app shows a keyboard shortcut.
 */
import type { ComponentProps } from 'react'
import { cn } from '../../lib/utils.js'

export function Kbd({ className, ...props }: ComponentProps<'kbd'>) {
  return (
    <kbd
      className={cn(
        'pointer-events-none inline-flex h-5 w-fit min-w-5 items-center justify-center gap-1 rounded-sm bg-muted px-1 font-mono text-xs font-medium text-muted-foreground select-none',
        className,
      )}
      {...props}
    />
  )
}

export function KbdGroup({ className, ...props }: ComponentProps<'span'>) {
  return <span className={cn('inline-flex items-center gap-1', className)} {...props} />
}

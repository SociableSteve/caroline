/** shadcn/ui's generated Textarea, hand-vendored (see button.tsx for why). */
import type { ComponentProps } from 'react'
import { cn } from '../../lib/utils.js'

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      className={cn(
        'w-auto rounded-sm border border-input bg-card px-2 py-1 text-base text-foreground placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60',
        className,
      )}
      {...props}
    />
  )
}

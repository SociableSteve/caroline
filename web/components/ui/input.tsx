/** shadcn/ui's generated Input, hand-vendored (see button.tsx for why). */
import type { ComponentProps } from 'react'
import { cn } from '../../lib/utils.js'

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      className={cn(
        'h-9 w-auto rounded-sm border border-input bg-card px-2 py-1 text-base text-foreground placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60',
        className,
      )}
      {...props}
    />
  )
}

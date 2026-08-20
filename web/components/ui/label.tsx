/** shadcn/ui's generated Label, hand-vendored (see button.tsx for why): a thin styling wrapper
 *  over Radix's Label primitive, which renders a real native label element and handles the
 *  click-to-focus association with its control the same way one does. */
import * as LabelPrimitive from '@radix-ui/react-label'
import type { ComponentProps } from 'react'
import { cn } from '../../lib/utils.js'

export function LabelUi({ className, ...props }: ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      className={cn('flex flex-col gap-1 text-sm text-muted-foreground', className)}
      {...props}
    />
  )
}

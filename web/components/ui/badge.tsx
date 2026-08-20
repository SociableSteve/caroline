/** shadcn/ui's generated Badge, hand-vendored (see button.tsx for why). */
import { cva, type VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'
import { cn } from '../../lib/utils.js'

export const badgeVariants = cva(
  'inline-block rounded-full border px-2 text-xs font-medium leading-5',
  {
    variants: {
      variant: {
        // Filled tags, matching the export's task-card badges: `border-transparent
        // bg-<tone>/15 text-<tone>`, keyed off the chart ramp for the app's one accent colour
        // rather than a bespoke tone of its own.
        quiet: 'border-transparent bg-muted text-muted-foreground',
        alarm: 'border-transparent bg-destructive/15 text-destructive',
        accent: 'border-transparent bg-chart-2/15 text-chart-1',
        outline: 'border-border text-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        ghost: 'border-transparent bg-transparent text-foreground',
        link: 'border-transparent bg-transparent p-0 text-primary underline-offset-4',
      },
    },
    defaultVariants: { variant: 'quiet' },
  },
)

export interface BadgeUiProps extends ComponentProps<'span'>, VariantProps<typeof badgeVariants> {}

export function BadgeUi({ className, variant, ...props }: BadgeUiProps) {
  return <span className={cn(badgeVariants({ variant, className }))} {...props} />
}

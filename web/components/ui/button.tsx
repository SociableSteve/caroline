/**
 * shadcn/ui's generated Button, hand-vendored (no network access to the shadcn registry from this
 * environment) rather than pulled by the CLI, but otherwise the same cva-based pattern the CLI
 * itself would emit: a `buttonVariants` export other components can reuse, and a component that
 * forwards every native `<button>` prop untouched.
 */
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'
import { cn } from '../../lib/utils.js'

export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-sm text-sm font-medium transition-colors disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-60 [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        // The one filled, neutral primary of spec 10's appearance model. Carries the literal
        // `primary` class too: `design-system.test.tsx` counts these per row of controls, and the
        // rest of the codebase (LoginScreen, QuickCapture, ChatRail's composer, ...) already
        // selects on it directly.
        default:
          'primary bg-primary text-primary-foreground border border-primary hover:opacity-90',
        outline:
          'bg-card text-foreground border border-input hover:bg-accent hover:text-accent-foreground',
        ghost: 'bg-transparent text-foreground hover:bg-accent hover:text-accent-foreground',
        destructive:
          'bg-destructive text-destructive-foreground border border-destructive hover:opacity-90',
        link: 'bg-transparent p-0 text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-3 py-1',
        xs: 'h-6 gap-1 px-2 text-[11px]',
        sm: 'h-8 px-2 text-xs',
        lg: 'h-10 px-4',
        icon: 'size-9',
        'icon-xs': 'size-6 [&_svg]:size-3',
      },
    },
    defaultVariants: {
      variant: 'outline',
      size: 'default',
    },
  },
)

export interface ButtonProps extends ComponentProps<'button'>, VariantProps<typeof buttonVariants> {
  readonly asChild?: boolean
}

export function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : 'button'
  return <Comp className={cn(buttonVariants({ variant, size, className }))} {...props} />
}

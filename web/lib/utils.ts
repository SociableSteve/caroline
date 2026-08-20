import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** shadcn/ui's standard class-merging helper: clsx for conditional classes, tailwind-merge to
 *  resolve conflicting utility classes (the last one wins) rather than emitting both. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

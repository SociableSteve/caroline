/**
 * The two appearance-model checks `styles.test.ts` used to make against `.primary` and `.card`'s
 * own CSS moved here once both became shadcn/ui components: a `cva` variant string in this
 * directory's own source is where they are declared now, not a rule in `web/styles.css`.
 *
 * Spec 10, criteria 14 and 16.
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { buttonVariants, Button } from './button.js'
import { Card } from './card.js'

/** Criterion 14: the one filled primary, neutral rather than coloured. */
describe('the primary button', () => {
  it('is filled with the neutral primary token, not accent-coloured text in an outline', () => {
    const classes = buttonVariants({ variant: 'default' })

    expect(classes).toContain('bg-primary')
    expect(classes).toContain('text-primary-foreground')
  })

  it('carries the literal `primary` class design-system.test.tsx counts per row of controls', () => {
    render(<Button variant="default">Go</Button>)
    expect(screen.getByRole('button', { name: 'Go' })).toHaveClass('primary')
  })
})

/**
 * Criterion 16: a region is placed by its ground and its radius, not by an outline drawn round it.
 * The habit this replaced was a `1px` box on everything, which is why the absence of a border is
 * asserted rather than left implied.
 */
describe('a card', () => {
  it('is raised with the card background and foreground tokens', () => {
    render(<Card data-testid="card">content</Card>)
    const card = screen.getByTestId('card')

    expect(card).toHaveClass('bg-card')
    expect(card).toHaveClass('text-card-foreground')
  })

  it('is rounded on the scale and draws no border of its own', () => {
    render(<Card data-testid="card">content</Card>)
    const classes = Array.from(screen.getByTestId('card').classList)

    expect(classes).toContain('rounded-md')
    expect(classes.filter((name) => name.startsWith('border'))).toEqual([])
  })
})

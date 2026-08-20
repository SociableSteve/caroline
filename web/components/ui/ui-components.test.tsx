/**
 * The two appearance-model checks `styles.test.ts` used to make against `.primary` and `.card`'s
 * own CSS moved here once both became shadcn/ui components: a `cva` variant string in this
 * directory's own source is where they are declared now, not a rule in `web/styles.css`.
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { buttonVariants, Button } from './button.js'
import { Card } from './card.js'

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

describe('a card', () => {
  it('is raised with the card background and foreground tokens', () => {
    render(<Card data-testid="card">content</Card>)
    const card = screen.getByTestId('card')

    expect(card).toHaveClass('bg-card')
    expect(card).toHaveClass('text-card-foreground')
  })
})

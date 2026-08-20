/**
 * The stylesheet, read as data.
 *
 * Once the shadcn/ui migration moved every surface onto Tailwind utility classes in JSX and
 * shadcn's own generated components (`web/components/ui/*`), almost nothing that used to live in
 * hand-written CSS still does: a board that scrolls sideways, a rail that scrolls within the
 * viewport, and the rest of what `web/surfaces/*.tsx` draws are now literal Tailwind class names
 * on the elements that need them, not a rule in this file, and jsdom lays nothing out, so a test
 * cannot tell a class name applied from a class name that does something. What is left here is
 * what still lives in `web/styles.css` itself: the theme import, shadcn's own token set in both
 * palettes, and the couple of element-level rules that apply everywhere.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { declarations } from '../test/helpers/css.js'

// Read from the project root rather than from `import.meta.url`: these run under jsdom, where
// the module URL is an `http:` one and `fileURLToPath` refuses it.
const stylesheet = readFileSync(join(process.cwd(), 'web/styles.css'), 'utf8')
const all = declarations(stylesheet)

describe('the stylesheet has declarations to check', () => {
  it('so a parse failure cannot pass as a clean sheet', () => {
    expect(all.length).toBeGreaterThan(20)
  })
})

it('imports Tailwind, the engine every surface’s utility classes resolve against', () => {
  expect(stylesheet).toMatch(/@import\s+['"]tailwindcss['"]/)
})

/**
 * shadcn/ui's own token set (`background`, `foreground`, `card`, `primary`, `secondary`, `muted`,
 * `accent`, `destructive`, `border`, `input`, `ring`, and the two `-foreground` pairs), unmodified
 * from what `shadcn init` generates: no bespoke five-ground ramp, no separate accent or alarm
 * ramp, and no `--nav-active`. Dark is the unconditioned default (`:root`, no query, no `.dark`
 * class and no `data-theme` attribute, because this deployment has no manual toggle), and
 * `@media (prefers-color-scheme: light)` overrides the same names for a system that prefers it.
 *
 * Also included: the chart ramp (`chart-1`..`chart-5`), the only chromatic tokens in the system
 * and the carrier for the design's blue accent, and the `sidebar` family, which distinguishes
 * chrome (header, chat rail, needs-you rail) from ordinary panels (`card`).
 */
describe('shadcn’s token set, in both palettes', () => {
  const shadcnTokens = [
    'background',
    'foreground',
    'card',
    'card-foreground',
    'popover',
    'popover-foreground',
    'primary',
    'primary-foreground',
    'secondary',
    'secondary-foreground',
    'muted',
    'muted-foreground',
    'accent',
    'accent-foreground',
    'destructive',
    'border',
    'input',
    'ring',
    'chart-1',
    'chart-2',
    'chart-3',
    'chart-4',
    'chart-5',
    'sidebar',
    'sidebar-foreground',
    'sidebar-accent',
    'sidebar-accent-foreground',
    'sidebar-border',
  ]

  const withoutComments = stylesheet.replace(/\/\*[\s\S]*?\*\//g, '')
  const dark = all.filter(
    (declaration) => declaration.selector === ':root' && declaration.context === '',
  )
  const lightBlock = /@media \(prefers-color-scheme: light\) \{\s*:root \{([^]*?)\n\s*\}\s*\}/.exec(
    withoutComments,
  )
  const light = new Set(
    (lightBlock?.[1] ?? '')
      .split(';')
      .map((line) => line.split(':')[0]?.trim() ?? '')
      .filter((name) => name.startsWith('--')),
  )

  it('finds the light override, so an empty match cannot pass as a complete one', () => {
    expect(lightBlock).not.toBeNull()
  })

  it.each(shadcnTokens)('declares --%s in both palettes', (name) => {
    expect(dark.map((declaration) => declaration.property)).toContain(`--${name}`)
    expect(light).toContain(`--${name}`)
  })

  it('has no manual toggle: no `.dark` class and no `data-theme` selector', () => {
    const withoutComments = stylesheet.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(withoutComments).not.toMatch(/\.dark\b/)
    expect(withoutComments).not.toMatch(/data-theme/)
  })
})

/**
 * shadcn's own radius convention: one `--radius` and the `sm`/`md`/`lg`/`xl` steps Tailwind's
 * `@theme inline` derives from it, exactly as `shadcn init` generates them.
 */
describe('shadcn’s radius scale', () => {
  it('derives every step from one `--radius` rather than restating each', () => {
    expect(stylesheet).toMatch(/--radius:\s*[\d.]+rem/)
    expect(stylesheet).toMatch(/--radius-sm:\s*calc\(var\(--radius\)/)
    expect(stylesheet).toMatch(/--radius-md:\s*calc\(var\(--radius\)/)
    expect(stylesheet).toMatch(/--radius-lg:\s*var\(--radius\)/)
  })
})

/** Criterion 9: focus is visible on every interactive element, the card and its disclosure
 *  included, and on shadcn's own `--ring` token rather than a bespoke accent colour. */
describe('focus', () => {
  it('is declared once, globally, rather than per control', () => {
    expect(stylesheet).toMatch(/:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--ring\)/)
    expect(stylesheet).toMatch(/:focus-visible\s*\{[^}]*outline-offset:\s*2px/)
  })

  it('is never removed by a rule that would undo it', () => {
    expect(stylesheet).not.toMatch(/outline:\s*(none|0)/)
  })
})

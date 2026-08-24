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
import {
  declarations,
  hasColourLiteral,
  offTheScales,
  untokenisedColours,
} from '../test/helpers/css.js'

// Read from the project root rather than from `import.meta.url`: these run under jsdom, where
// the module URL is an `http:` one and `fileURLToPath` refuses it.
const stylesheet = readFileSync(join(process.cwd(), 'web/styles.css'), 'utf8')
const all = declarations(stylesheet)

/**
 * shadcn's own token set, both palettes, as the two sweeps that need it read it: criterion 3 asks
 * that each name is declared in oklch in both, and criterion 2's whitelist asks which custom
 * properties are allowed to carry a colour literal at all.
 */
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
  'destructive-foreground',
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
 * `accent`, `destructive`, `border`, `input`, `ring`, and the `-foreground` pairs), at the values
 * `shadcn init` generates apart from the one addition named below: no bespoke five-ground ramp, no
 * separate accent or alarm ramp, and no `--nav-active`. Dark is the unconditioned default (`:root`,
 * no query, no `.dark` class and no `data-theme` attribute, because this deployment has no manual
 * toggle), and `@media (prefers-color-scheme: light)` overrides the same names for a system that
 * prefers it.
 *
 * Also included: the chart ramp (`chart-1`..`chart-5`), the only chromatic tokens in the system
 * and the carrier for the design's blue accent, and the `sidebar` family, which distinguishes
 * chrome (header, chat rail, needs-you rail) from ordinary panels (`card`).
 *
 * `destructive-foreground` is in the list and is the one name stock shadcn no longer generates: it
 * writes `text-white` on the destructive button instead, which this palette does not follow because
 * white on the dark palette's light red is about 2.9:1. Spec 10, criterion 23 is why it has to be
 * declared rather than assumed.
 *
 * Spec 10, criterion 3: the whole set in both palettes, every value in oklch, and no manual toggle.
 */
describe('shadcn’s token set, in both palettes', () => {
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
  // The same block again, read through the parser rather than by regex, so criterion 3's
  // colour-space half has a value to check and not only a name.
  const lightValues = new Map(
    all
      .filter(
        (declaration) =>
          declaration.selector === ':root' &&
          declaration.context === '@media (prefers-color-scheme: light)',
      )
      .map((declaration) => [declaration.property, declaration.value] as const),
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

  // Criterion 3's colour-space half. A token restated in hex or `rgb()` is a value nobody can
  // reason about beside the oklch ones around it, and it is how a hand-tuned palette comes back
  // one token at a time.
  it.each(shadcnTokens)('declares --%s in oklch, in both palettes', (name) => {
    const property = `--${name}`
    const inDark = dark.find((declaration) => declaration.property === property)

    expect(inDark?.value).toMatch(/^oklch\(/)
    expect(lightValues.get(property)).toMatch(/^oklch\(/)
  })
})

/**
 * Criterion 1 and criterion 2, applied to the application's own stylesheet. Almost nothing is left
 * for them to catch here, because the surfaces space, size, round and colour themselves in Tailwind
 * utility classes rather than in rules in this file. That is exactly why the check stays: the next
 * rule added to this sheet is the one that would reintroduce a literal, and `site/styles.css` (which
 * does still carry many such rules) is held to the same two criteria by `test/site/build.test.ts`.
 */
describe('the rules the sheet still owns, held to the scales', () => {
  const own = all.filter((declaration) => !declaration.property.startsWith('--'))

  it('has rules of its own to check, so a parse failure cannot pass as a clean sheet', () => {
    expect(own.length).toBeGreaterThan(3)
  })

  // Criteria 1 and 2, through the predicates in `test/helpers/css.ts`, which `test/site/build.test.ts`
  // holds `site/styles.css` to with the same two calls. `outline-offset` is a length rather than a
  // colour, and `color-scheme` names the two palettes rather than a value in either, so neither is a
  // colour decision and neither property is in the set.
  it('spaces, sizes and rounds only from the scales', () => {
    expect(offTheScales(own)).toEqual([])
  })

  it('names a colour only as a token, so no rule is right in one theme alone', () => {
    expect(untokenisedColours(own)).toEqual([])
  })

  /**
   * Criterion 2's other half, and the reason the criterion is scoped to what a rule applies to an
   * element rather than to every declaration in the file. A palette is where colour literals live,
   * so `--background: oklch(...)` is not a violation; a custom property outside the palette that
   * carries one is, because it is a colour chosen once for both themes under a name that hides it.
   * `--shadow-1` is the single named exception: a shadow is a colour and two lengths together, there
   * is no shadow token to point at, and it is restated per palette rather than shared.
   *
   * The sweep is a whitelist rather than a blocklist on purpose: the previous version filtered every
   * `--` property out and so could not have failed on the exception it was silent about.
   */
  it('keeps colour literals in the palettes, `--shadow-1` aside', () => {
    const palette = new Set(shadcnTokens.map((name) => `--${name}`))
    const strays = all
      .filter(
        (declaration) =>
          declaration.property.startsWith('--') &&
          hasColourLiteral(declaration.value) &&
          !palette.has(declaration.property),
      )
      .map((declaration) => declaration.property)

    expect([...new Set(strays)]).toEqual(['--shadow-1'])
  })
})

/**
 * Criterion 11. A surface heading and a panel heading are a rank apart rather than a rounding error
 * apart, which is why this application overrides Tailwind's own `--text-xl` (`1.25rem`, one 0.25rem
 * step above `--text-lg`) with a value that earns the rank.
 */
describe('the type scale', () => {
  const rem = (property: string): number => {
    const declaration = all.find(
      (candidate) =>
        candidate.selector === ':root' &&
        candidate.context === '' &&
        candidate.property === property,
    )
    expect(declaration, property).toBeDefined()

    return Number.parseFloat(declaration?.value.replace('rem', '') ?? 'NaN')
  }

  it('puts --text-xl at least 0.5rem above --text-lg', () => {
    expect(rem('--text-xl') - rem('--text-lg')).toBeGreaterThanOrEqual(0.5)
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

  /**
   * Criterion 9's other half, and the reason `outline-none` on shadcn's select trigger and item does
   * not undo focus. Tailwind emits every utility inside `@layer utilities`, and a declaration in a
   * cascade layer loses to an unlayered one of the same specificity whatever the source order, so
   * the rule below wins because it sits outside every layer. Move it into one and the utility starts
   * winning, silently, which is what this asserts against: the parser records the at-rules a
   * declaration sits inside, and this one's context has to be empty.
   */
  it('sits outside every cascade layer, so a utility cannot beat it', () => {
    const rule = all.filter((declaration) => declaration.selector === ':focus-visible')

    expect(rule).not.toEqual([])
    expect(rule.map((declaration) => declaration.context)).toEqual(rule.map(() => ''))
  })
})

/**
 * The stylesheet, read as data. Spec 10's first criterion is the one that makes the rest of it
 * hold: a convention the codebase does not follow is aspirational, so the scales are parsed and
 * enforced rather than written down and hoped for.
 *
 * The rules, all about what a declaration is allowed to say:
 *
 * - A spacing, font size or border radius resolves to a token. A literal length in one of those
 *   properties is the defect M9 existed to remove, and it comes back one hurried declaration at a
 *   time unless something fails.
 * - A colour is a token. A literal is a rule that can be right in one theme and wrong in the
 *   other, which is exactly what the two palettes are for.
 * - Weight is scarce, and small text is not uppercased. Both are M10's appearance model, and both
 *   are the kind of rule that decays into "everything at 600" unless something counts.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { declarations, type Declaration } from '../test/helpers/css.js'

// Read from the project root rather than from `import.meta.url`: these run under jsdom, where
// the module URL is an `http:` one and `fileURLToPath` refuses it.
const stylesheet = readFileSync(join(process.cwd(), 'web/styles.css'), 'utf8')

const all = declarations(stylesheet)

/** A declaration of a token is where a literal belongs: it is the definition of the scale. */
const rules = all.filter((declaration) => !declaration.property.startsWith('--'))

/** `0` has no unit and needs no scale, and the keywords are not lengths at all. */
const lengthExempt = new Set(['0', 'auto', 'inherit', 'initial', 'unset', 'none', '100%'])

/** A shorthand is tokenised when every one of its parts is. */
function isTokenised(value: string): boolean {
  return value.split(/\s+/).every((part) => lengthExempt.has(part) || part.startsWith('var(--'))
}

const spacingProperties = /^(margin|padding)(-(top|right|bottom|left))?$/
const gapProperties = /^(gap|row-gap|column-gap)$/
const radiusProperties = /^border-(top|bottom)-(left|right)-radius$|^border-radius$/

describe('the stylesheet holds to the scales', () => {
  it('has declarations to check, so a parse failure cannot pass as a clean sheet', () => {
    expect(rules.length).toBeGreaterThan(100)
  })

  it('spaces everything from the space scale', () => {
    const literals = rules.filter(
      (rule) =>
        (spacingProperties.test(rule.property) || gapProperties.test(rule.property)) &&
        !isTokenised(rule.value),
    )

    expect(literals).toEqual([])
  })

  it('sizes every piece of text from the type scale', () => {
    const literals = rules.filter(
      (rule) => rule.property === 'font-size' && !isTokenised(rule.value),
    )

    expect(literals).toEqual([])
  })

  it('rounds every corner from the radius scale', () => {
    const literals = rules.filter(
      (rule) => radiusProperties.test(rule.property) && !isTokenised(rule.value),
    )

    expect(literals).toEqual([])
  })

  it('leads every line from the two line heights', () => {
    const literals = rules.filter(
      (rule) => rule.property === 'line-height' && !rule.value.startsWith('var('),
    )

    expect(literals).toEqual([])
  })
})

/**
 * The two board rules its layout was missing. Spec 08, criteria 12 and 13. They are asserted
 * against the stylesheet because they are layout: jsdom lays nothing out, so a render can say the
 * six columns exist but never that they are on one row.
 */
describe('the board is six columns and stays six', () => {
  /** The base rules only: what a wide screen gets, which is what criteria 12 and 13 are about. */
  const base = (selector: string) =>
    rules.filter((rule) => rule.selector === selector && rule.context === '')
  const value = (declarations: Declaration[], property: string) =>
    declarations.find((rule) => rule.property === property)?.value

  // A wrapped column sits below and to the left of a column it is logically to the right of,
  // which puts the layout in direct contradiction with the arrow keys.
  it('flows the columns along one row and scrolls sideways rather than wrapping', () => {
    expect(value(base('.board'), 'grid-auto-flow')).toBe('column')
    expect(value(base('.board'), 'overflow-x')).toBe('auto')
    // `auto-fit` is what wrapped the sixth column onto a second row at 1440px.
    expect(value(base('.board'), 'grid-template-columns')).toBeUndefined()
  })

  /**
   * Without this the page grows to the length of the longest column, two columns of very
   * different lengths cannot be compared, and the status a card should move to can be off the
   * bottom of the screen while the card is in view.
   *
   * `overflow-y: auto` on the list is what bounds it, and not only by making it scrollable: a
   * flex item's automatic minimum size is zero when its computed overflow is not `visible`, so
   * the list is free to shrink under the column's cap without a `min-height` of its own.
   */
  it('bounds the height of each column and scrolls its cards within it', () => {
    expect(value(base('.column'), 'max-height')).toBeDefined()
    expect(value(base('.column-cards'), 'overflow-y')).toBe('auto')
  })

  // Below the width where six columns are usable they stack, and each is read whole. Asserted
  // inside a breakpoint: the same declaration in the base rule would be the defect, not the fix.
  it('stacks them below the breakpoint rather than leaving a sideways scroll on a phone', () => {
    const stacked = rules.filter(
      (rule) =>
        rule.selector === '.board' &&
        rule.context.startsWith('@media') &&
        rule.property === 'grid-auto-flow' &&
        rule.value === 'row',
    )

    expect(stacked).not.toEqual([])
  })
})

/**
 * Criterion 4, the half of it that is about the stylesheet: a surface does not restate a
 * primitive's ground, border, radius and padding. Anything that wants those four is a Panel.
 */
describe('no surface restates the panel', () => {
  const panelRadius = rules.filter(
    (rule) => rule.property === 'border-radius' && rule.value === 'var(--radius-md)',
  )

  it('is the only rule rounding a region at the panel radius, bar the ones that are not panels', () => {
    // A card, a chat turn, a confirmation, the capture dialog and the two notes are components in
    // their own right rather than panels written again, and issue #47 adds two more: the app-level
    // alert row, and the rail's details region once it became a bordered card of its own rather than
    // a plain, unbounded region of the rail. `.agenda-card` is Steve's own fix for the agenda's items:
    // a card of its own beside the clock time, not a panel, since the agenda sits directly on `--page`
    // with no panel beneath it. Anything new belongs in `Panel`.
    expect(panelRadius.map((rule) => rule.selector).sort()).toEqual(
      [
        '.agenda-card',
        '.alert-row',
        '.capture',
        '.card',
        '.chat-confirmation',
        '.chat-note, .chat-readonly',
        '.chat-turn',
        '.panel',
        '.rail-details',
      ].sort(),
    )
  })
})

describe('the stylesheet holds to the palettes', () => {
  const colourProperties =
    /^(color|background|background-color|border-color|border-(top|right|bottom|left)-color|outline-color|fill|stroke)$/
  /** The palettes themselves, where the literals are the point. */
  const palette = (selector: string) => selector === ':root'

  it('names a colour only as a token, so no rule can be right in one theme alone', () => {
    const literals = rules.filter(
      (rule) =>
        colourProperties.test(rule.property) &&
        !palette(rule.selector) &&
        !rule.value.startsWith('var(') &&
        rule.value !== 'transparent' &&
        rule.value !== 'inherit' &&
        rule.value !== 'none',
    )

    expect(literals).toEqual([])
  })

  it('names a colour only as a token in a border, an outline or a shadow too', () => {
    // `box-shadow` is here because the appearance model is heading towards elevation, and a
    // shadow is a colour: the same one over a light ground and a dark one is wrong in one of them.
    const shorthand = /^(border|border-(top|right|bottom|left)|outline|box-shadow|text-shadow)$/
    const literals = rules.filter(
      (rule) =>
        shorthand.test(rule.property) &&
        !palette(rule.selector) &&
        !rule.value.includes('var(') &&
        rule.value !== 'none',
    )

    expect(literals).toEqual([])
  })

  /**
   * Issue #47 flips which palette is unconditioned: dark is now the default, drawn directly on
   * `:root`, because every mockup draws dark first and nothing in the codebase offered a manual
   * override to fall back from. `@media (prefers-color-scheme: light)` overrides the same tokens
   * for a system that prefers light, and nothing else.
   */
  it('defines every colour token in both palettes, and overrides nothing else in the light one', () => {
    const dark = all.filter(
      (declaration) => declaration.selector === ':root' && declaration.property.startsWith('--'),
    )
    // The light block is the only other place `:root` is opened, inside the media query.
    const lightBlock = /@media \(prefers-color-scheme: light\) \{\s*:root \{([^}]*)\}/.exec(
      stylesheet.replace(/\/\*[\s\S]*?\*\//g, ''),
    )
    expect(lightBlock).not.toBeNull()

    const light = (lightBlock?.[1] ?? '')
      .split(';')
      .map((line) => line.split(':')[0]?.trim() ?? '')
      .filter((name) => name.startsWith('--'))

    const colourTokens = [
      '--page',
      '--chrome',
      '--surface',
      '--surface-sunk',
      '--surface-raised',
      '--nav-active',
      '--ink',
      '--ink-quiet',
      '--line-faint',
      '--line',
      '--primary',
      '--primary-ink',
      '--accent',
      '--accent-text',
      '--accent-tint',
      '--alarm',
      '--alarm-text',
      '--alarm-surface',
      '--scrim',
      '--shadow-1',
      '--shadow-2',
    ]

    for (const token of colourTokens) {
      expect(dark.map((declaration) => declaration.property)).toContain(token)
    }

    expect([...light].sort()).toEqual([...colourTokens].sort())
  })
})

/**
 * The appearance model M9 never had, as rules a sheet can be held to. Spec 10.
 *
 * Each of these was a real defect found by driving the seeded day in a browser rather than a
 * preference: the page and a card were the same white, four rules set small text in uppercase with
 * tracking, everything that wanted emphasis was at 600, and `.primary` was accent-coloured text in an
 * outlined box rather than a filled action.
 */
describe('the appearance model', () => {
  const token = (name: string, context = '') =>
    all.find(
      (rule) => rule.selector === ':root' && rule.property === name && rule.context === context,
    )?.value

  /**
   * Both palettes, because "designed, not inverted" is the claim and a ramp that collapses in the
   * light theme is exactly the regression this is for: the dark values could stay five and distinct
   * while the light override quietly made two of them the same. Dark is the unconditioned default
   * since issue #47; light is the override.
   */
  const palettes = [
    { theme: 'dark', context: '' },
    { theme: 'light', context: '@media (prefers-color-scheme: light)' },
  ]

  it.each(palettes)(
    'grounds a ramp of five in the $theme palette, so a card is not the colour of the page',
    ({ context }) => {
      const grounds = ['--page', '--chrome', '--surface', '--surface-sunk', '--surface-raised'].map(
        (name) => token(name, context),
      )

      expect(grounds.every((value) => value !== undefined)).toBe(true)
      expect(new Set(grounds).size).toBe(grounds.length)
    },
  )

  it.each(palettes)(
    'has two lines in the $theme palette, one for a component edge and one for a divider',
    ({ context }) => {
      expect(token('--line', context)).toBeDefined()
      expect(token('--line-faint', context)).toBeDefined()
      expect(token('--line', context)).not.toBe(token('--line-faint', context))
    },
  )

  /** A surface heading and a panel heading were 0.25rem apart, which is not a hierarchy. */
  it('separates the surface heading from a panel heading by more than a rounding error', () => {
    const xl = Number.parseFloat(String(token('--text-xl')))
    const lg = Number.parseFloat(String(token('--text-lg')))

    expect(xl - lg).toBeGreaterThanOrEqual(0.5)
  })

  it('spends 600 on the surface heading and nowhere else', () => {
    const strong = rules.filter(
      (rule) => rule.property === 'font-weight' && Number.parseInt(rule.value, 10) >= 600,
    )

    expect(strong.map((rule) => rule.selector)).toEqual(['h1'])
  })

  it('never sets a weight above 600, or below 400', () => {
    const weights = rules
      .filter((rule) => rule.property === 'font-weight' && /^\d+$/.test(rule.value))
      .map((rule) => Number.parseInt(rule.value, 10))

    expect(weights.filter((weight) => weight > 600 || weight < 400)).toEqual([])
  })

  /**
   * Small text is small. Uppercase and *wide* tracking are not a rank, and four rules used them as
   * one. Issue #47 asks titles to be tracking-*tight* instead (a small negative value on `h1` and
   * the wordmark), which is a different, deliberate thing from the shouting pattern this guards
   * against, so only positive (widening) letter-spacing counts here.
   */
  it('uppercases nothing and tracks nothing wide', () => {
    const shouting = rules.filter(
      (rule) =>
        (rule.property === 'text-transform' && rule.value === 'uppercase') ||
        (rule.property === 'letter-spacing' && Number.parseFloat(rule.value) > 0),
    )

    expect(shouting).toEqual([])
  })

  /**
   * Issue #47: the primary action is filled, but neutral rather than chromatic. Both mockups draw
   * it near-black-on-white or near-white-on-black, never the blue ramp, which is reserved for
   * links, badges and selection instead.
   */
  it('fills the primary action rather than outlining accent-coloured text', () => {
    const primary = rules.filter((rule) => rule.selector === '.primary' && rule.context === '')

    expect(primary.find((rule) => rule.property === 'background')?.value).toBe('var(--primary)')
    expect(primary.find((rule) => rule.property === 'color')?.value).toBe('var(--primary-ink)')
  })

  /** Depth from a shadow, plus the same hairline border every bordered surface uses: issue #47's
   *  mockup draws a visible edge round every card, not a shadow alone. */
  it('raises a card with a shadow and the standard hairline border', () => {
    const card = rules.filter((rule) => rule.selector === '.card' && rule.context === '')

    expect(card.find((rule) => rule.property === 'box-shadow')?.value).toContain('var(--shadow-1)')
    expect(card.find((rule) => rule.property === 'border')?.value).toContain('var(--line)')
  })
})

/**
 * The chat rail. Spec 08: a companion beside the surface rather than a route, and below the width
 * where a rail leaves the surface usable, the overlay pattern quick capture already owns.
 */
describe('the chat rail', () => {
  const base = (selector: string) =>
    rules.filter((rule) => rule.selector === selector && rule.context === '')
  const value = (declarations: Declaration[], property: string) =>
    declarations.find((rule) => rule.property === property)?.value

  it('takes a column beside the surface rather than the whole shell', () => {
    expect(value(base('.app-body'), 'grid-template-columns')).toBe('minmax(0, 1fr)')
    expect(value(base('.app-body.with-rail'), 'grid-template-columns')).toMatch(
      /^minmax\(0, 1fr\) /,
    )
  })

  /** Without this a long transcript lengthens the surface it was supposed to sit beside. */
  it('scrolls within the viewport instead of lengthening the surface beside it', () => {
    expect(value(base('.chat-rail'), 'overflow-y')).toBe('auto')
    expect(value(base('.chat-rail'), 'max-height')).toBeDefined()
  })

  it('leaves the flow and sits above the surface below the breakpoint', () => {
    const collapsed = rules.filter(
      (rule) => rule.selector === '.chat-rail' && rule.context.startsWith('@media'),
    )

    expect(value(collapsed, 'position')).toBe('fixed')
    expect(value(collapsed, 'box-shadow')).toBe('var(--shadow-2)')
  })

  /**
   * The rail's second region. Spec 08, criterion 30: the details of the open item sit above the
   * conversation, bounded, so a task with long notes never takes the rail from the conversation it is
   * supposed to be the subject of. Asserted against the stylesheet because it is layout, and jsdom
   * lays nothing out.
   */
  it('bounds the details region and scrolls it within the rail rather than letting it take it', () => {
    expect(value(base('.rail-details'), 'max-height')).toBeDefined()
    expect(value(base('.rail-details'), 'overflow-y')).toBe('auto')
    // Pinned, so the conversation scrolls past the thing it is about rather than under it.
    expect(value(base('.rail-details'), 'position')).toBe('sticky')
  })

  /** A short viewport gives the height to the conversation: the cap tightens rather than the rail. */
  it('tightens that cap in a short viewport instead of squeezing the transcript', () => {
    const short = rules.filter(
      (rule) =>
        rule.selector === '.rail-details' &&
        rule.context.startsWith('@media (max-height') &&
        rule.property === 'max-height',
    )

    expect(short).not.toEqual([])
    expect(Number.parseFloat(short[0]?.value ?? '100')).toBeLessThan(
      Number.parseFloat(value(base('.rail-details'), 'max-height') ?? '0'),
    )
  })
})

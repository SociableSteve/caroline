/**
 * The stylesheet, read as data. Spec 10's first criterion is the one that makes the rest of it
 * hold: a convention the codebase does not follow is aspirational, so the scales are parsed and
 * enforced rather than written down and hoped for.
 *
 * Two rules, both about what a declaration is allowed to say:
 *
 * - A spacing, font size or border radius resolves to a token. A literal length in one of those
 *   properties is the defect this milestone exists to remove, and it comes back one hurried
 *   declaration at a time unless something fails.
 * - A colour is a token. A literal is a rule that can be right in one theme and wrong in the
 *   other, which is exactly what the two palettes are for.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Read from the project root rather than from `import.meta.url`: these run under jsdom, where
// the module URL is an `http:` one and `fileURLToPath` refuses it.
const stylesheet = readFileSync(join(process.cwd(), 'web/styles.css'), 'utf8')

interface Declaration {
  readonly selector: string
  /**
   * The at-rules a declaration sits inside, if any. Without it a rule in a breakpoint and the
   * base rule it overrides are indistinguishable, and an assertion about one silently reads the
   * other: the source order decides, rather than the cascade.
   */
  readonly context: string
  readonly property: string
  readonly value: string
}

/**
 * Enough of a CSS parser for the two questions asked here: which selector a declaration sits
 * under, and what it says. Comments go first, so prose about a `0.85rem` that was removed cannot
 * fail a test about a `0.85rem` that is still there.
 */
function declarations(css: string): Declaration[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const found: Declaration[] = []
  const stack: string[] = []
  let buffer = ''

  for (const character of withoutComments) {
    if (character === '{') {
      stack.push(buffer.trim().replace(/\s+/g, ' '))
      buffer = ''
    } else if (character === '}' || character === ';') {
      const [property = '', ...rest] = buffer.split(':')
      const value = rest.join(':').trim()
      if (value !== '') {
        found.push({
          selector: stack[stack.length - 1] ?? '',
          context: stack.slice(0, -1).join(' '),
          property: property.trim(),
          value,
        })
      }
      buffer = ''
      if (character === '}') stack.pop()
    } else {
      buffer += character
    }
  }

  return found
}

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

  it('is the only rule rounding a region at the panel radius, bar the four that are not panels', () => {
    // A card, a chat turn, a confirmation, the capture dialog and the two notes are components in
    // their own right rather than panels written again. Anything new belongs in `Panel`.
    expect(panelRadius.map((rule) => rule.selector).sort()).toEqual(
      [
        '.capture',
        '.card',
        '.chat-confirmation',
        '.chat-note, .chat-readonly',
        '.chat-turn',
        '.panel',
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

  it('defines every colour token in both palettes, and overrides nothing else in the dark one', () => {
    const light = all.filter(
      (declaration) => declaration.selector === ':root' && declaration.property.startsWith('--'),
    )
    // The dark block is the only other place `:root` is opened, inside the media query.
    const darkBlock = /@media \(prefers-color-scheme: dark\) \{\s*:root \{([^}]*)\}/.exec(
      stylesheet.replace(/\/\*[\s\S]*?\*\//g, ''),
    )
    expect(darkBlock).not.toBeNull()

    const dark = (darkBlock?.[1] ?? '')
      .split(';')
      .map((line) => line.split(':')[0]?.trim() ?? '')
      .filter((name) => name.startsWith('--'))

    const colourTokens = [
      '--page',
      '--surface',
      '--surface-raised',
      '--ink',
      '--ink-quiet',
      '--line',
      '--accent',
      '--alarm',
      '--alarm-surface',
      '--scrim',
    ]

    for (const token of colourTokens) {
      expect(light.map((declaration) => declaration.property)).toContain(token)
    }

    expect([...dark].sort()).toEqual([...colourTokens].sort())
  })
})

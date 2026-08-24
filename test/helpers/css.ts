/**
 * A stylesheet, read as data.
 *
 * Two suites hold a sheet to spec 10's scales: `web/styles.test.ts` for the application's, and
 * `test/site/build.test.ts` for the public site's, which is the same palette with a different set of
 * rules over it. They share this parser rather than a copy each, because a rule enforced by two
 * parsers is a rule enforced by whichever of them is less careful.
 */

export interface Declaration {
  readonly selector: string
  /**
   * The at-rules a declaration sits inside, if any. Without it a rule in a breakpoint and the base
   * rule it overrides are indistinguishable, and an assertion about one silently reads the other:
   * the source order decides, rather than the cascade.
   */
  readonly context: string
  readonly property: string
  readonly value: string
}

/**
 * Enough of a CSS parser for the two questions asked of it: which selector a declaration sits under,
 * and what it says. Comments go first, so prose about a `0.85rem` that was removed cannot fail a test
 * about a `0.85rem` that is still there.
 */
export function declarations(css: string): Declaration[] {
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

/**
 * Spec 10, criterion 1, as a predicate rather than a copy per caller. A length written straight into
 * a rule is the scale being bypassed, and the exempt values are the ones that name an absence
 * (`0`, `none`) or a containing box (`auto`, `100%`) rather than a rung.
 */
const exemptLengths = new Set(['0', 'auto', 'inherit', 'initial', 'unset', 'none', '100%'])

const scaleProperties =
  /^(margin|padding)(-(top|right|bottom|left))?$|^(gap|row-gap|column-gap)$|^font-size$|^border-radius$/

export function offTheScales(rules: readonly Declaration[]): Declaration[] {
  const tokenised = (value: string): boolean =>
    value.split(/\s+/).every((part) => exemptLengths.has(part) || part.startsWith('var(--'))

  return rules.filter((rule) => scaleProperties.test(rule.property) && !tokenised(rule.value))
}

/**
 * Spec 10, criterion 2. A colour written as a literal in a rule is a colour that can only be right
 * in one of the two palettes. A removed border and a removed shadow are the absence of a colour
 * rather than one, so they are exempt.
 */
const colourProperties =
  /^(color|background|background-color|border|border-(top|right|bottom|left)|border-color|outline|box-shadow|fill|stroke)$/

const absentColours = new Set(['transparent', 'inherit', 'none', '0'])

export function untokenisedColours(rules: readonly Declaration[]): Declaration[] {
  return rules.filter(
    (rule) =>
      colourProperties.test(rule.property) &&
      !rule.value.includes('var(') &&
      !absentColours.has(rule.value),
  )
}

/**
 * Whether a value carries a colour written out rather than pointed at. Used on the palettes' own
 * custom properties, where literals are unavoidable (a palette is where they live) and the question
 * is only which properties are allowed to carry one.
 */
export function hasColourLiteral(value: string): boolean {
  return /#[0-9a-fA-F]{3,8}\b|\b(rgba?|hsla?|oklch|oklab|lab|lch)\(/.test(value)
}

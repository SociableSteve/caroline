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

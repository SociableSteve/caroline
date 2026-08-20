/**
 * The public site, read as data. Spec 11.
 *
 * The site's whole claim is that it does not restate the documentation, so the tests are mostly
 * comparisons: this page against the file it renders, this stylesheet against the application's, this
 * link against the page it names. The generator returns its output as a map rather than writing it,
 * so every one of those comparisons is made against what would ship rather than against a directory
 * somebody has to clean up.
 */
import { readFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildSite,
  repositorySources,
  sitePages,
  slug,
  type SiteSources,
} from '../../site/build.js'
import { declarations } from '../helpers/css.js'

const root = process.cwd()
const built = buildSite()
const page = (path: string): string => {
  const contents = built.get(path)
  if (contents === undefined) throw new Error(`the build produced no ${path}`)
  return contents
}
const source = (path: string): string => readFileSync(join(root, path), 'utf8')

/** The pages, as opposed to the stylesheet and the icon: what has a `<title>` and a navigation. */
const documents = [...built].filter(([path]) => path.endsWith('.html'))

/** Tags out, entities back, whitespace collapsed: what a reader sees, in a form a test can match. */
function text(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The headings of a Markdown file, ignoring the ones inside fenced code, which are comments. */
function headings(markdown: string): string[] {
  const found: string[] = []
  let fenced = false
  for (const line of markdown.split('\n')) {
    if (line.startsWith('```')) fenced = !fenced
    else if (!fenced && /^#{1,6} /.test(line)) found.push(line.replace(/^#{1,6} /, '').trim())
  }
  return found
}

/** Inline markup removed, so a heading's rendered text can be compared with its source. */
function plain(markdown: string): string {
  return markdown.replace(/[`*_]/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
}

/**
 * Quoted either way, because a test that reads only the spelling this generator writes is a test that a
 * document's raw HTML walks past: the single-quoted form escaped both the build and this suite once.
 */
function attributes(html: string, attribute: 'href' | 'src'): string[] {
  const pattern = new RegExp(`${attribute}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'gi')

  return [...html.matchAll(pattern)].map((match) => match[1] ?? match[2] ?? '')
}

const identifiers = (html: string): Set<string> =>
  new Set([...html.matchAll(/id="([^"]*)"/g)].map((match) => match[1] ?? ''))

const isExternal = (href: string): boolean => /^[a-z]+:/.test(href)

describe('the site renders the documentation rather than restating it', () => {
  it('builds a page for every document, the specs included', () => {
    expect(built.has('index.html')).toBe(true)
    expect(built.has('setup.html')).toBe(true)
    expect(built.has('content-policy.html')).toBe(true)
    expect(built.has('reference.html')).toBe(true)
    expect(built.has('specs/index.html')).toBe(true)
    expect(built.has('specs/09-config-and-security.html')).toBe(true)
    expect(built.has('specs/11-public-site.html')).toBe(true)
    expect(built.has('styles.css')).toBe(true)
  })

  // Criterion 1. Every heading, so a section dropped in rendering fails here rather than being
  // noticed by a reader who cannot find the step they were sent to.
  it.each(sitePages().filter((entry) => entry.source !== 'site/pages/index.md'))(
    'carries every heading of $source, and its prose',
    ({ source: path, output }) => {
      const rendered = text(page(output))

      for (const heading of headings(source(path))) {
        expect(rendered).toContain(plain(heading))
      }
    },
  )

  it('renders the setup guide word for word, including the parts that are easy to lose', () => {
    const rendered = text(page('setup.html'))

    // A table cell, a list item and an inline code span containing what looks like a tag: three
    // things a renderer can quietly drop or mangle.
    expect(rendered).toContain('The database. Created on first run, migrated on every start')
    expect(rendered).toContain('Node 24.2.0 or later')
    expect(rendered).toContain('"model": "<a model id>"')
  })

  /**
   * The description is what a search result and a shared link show, so it is prose or it is nothing
   * useful: a document opening on a code fence would otherwise be described by a line of shell.
   */
  /**
   * A bullet is a hyphen or a star followed by a space. `**Something.**` opens a paragraph, and `docs/`
   * is written that way throughout, so a filter that skipped both would describe a document by a
   * paragraph further down or by nothing at all.
   */
  it('describes a document whose first paragraph opens in bold with that paragraph', () => {
    const bolded = override(
      'docs/plan.md',
      '# Caroline implementation plan\n\n**Derived from the specs.** They say what the system does.\n',
    )
    const description =
      /<meta name="description" content="([^"]*)"/.exec(
        buildSite(bolded).get('plan.html') ?? '',
      )?.[1] ?? ''

    expect(description).toContain('Derived from the specs.')
  })

  /** A URL a document escaped by habit is published as it was meant, not with the entity in it. */
  it('escapes a bare ampersand in a link and leaves an escaped one alone', () => {
    const escaped = override(
      'docs/plan.md',
      '# Caroline implementation plan\n\n[a](https://example.test/?a=1&amp;b=2) [b](https://example.test/?c=1&d=2)\n',
    )
    const rendered = buildSite(escaped).get('plan.html') ?? ''

    expect(rendered).toContain('href="https://example.test/?a=1&amp;b=2"')
    expect(rendered).toContain('href="https://example.test/?c=1&amp;d=2"')
    expect(rendered).not.toContain('&amp;amp;')
  })

  /** A name may carry digits and a numeric reference may be hexadecimal: three spellings, all exempt. */
  it('leaves every spelling of an entity in a URL alone', () => {
    const entities = override(
      'docs/plan.md',
      '# Caroline implementation plan\n\n[a](https://example.test/?a=1&#x26;b=2&sup2;=3)\n',
    )

    expect(buildSite(entities).get('plan.html')).toContain('?a=1&#x26;b=2&sup2;=3')
  })

  it('describes every page with a sentence rather than with a command or a list item', () => {
    for (const [path, contents] of documents) {
      const description = /<meta name="description" content="([^"]*)"/.exec(contents)?.[1] ?? ''

      expect(description.length, path).toBeGreaterThan(20)
      expect(description, path).toMatch(/^[A-Z(]/)
    }
  })

  /**
   * A comment is prose about the rules and not one of them, so neither the palette's opening brace nor
   * the accent the favicon is drawn in can be found inside one. Both halves are here: a brace that would
   * cut the block short, and a whole `:root {` that would be where the block is read from.
   */
  it.each([
    '/* A rule reads `a { b: c }` */',
    '/* The palette begins at :root { and ends at the brace that closes it. */',
    '/* Never write --accent: #ff0000 in a comment. */',
  ])('extracts the palette and the icon past %s', (comment) => {
    const original = source('web/styles.css')
    const commented = override('web/styles.css', original.replace(':root {', `${comment}\n:root {`))
    const built = buildSite(commented)
    const stylesheet = built.get('styles.css') ?? ''

    // Read the values dynamically rather than hardcode them: what matters here is that a comment
    // ahead of `:root {` does not confuse the extraction, not what shade of the theme this
    // application currently declares. `styles.test.ts` and the tests below already hold those
    // values to their own rules.
    const darkAccent = /:root \{([^]*?)\n\}/.exec(original)?.[1]?.match(/--accent:\s*([^;]+);/)?.[1]
    const lightAccent = /@media \(prefers-color-scheme: light\) \{\s*:root \{([^]*?)\n {2}\}/
      .exec(original)?.[1]
      ?.match(/--accent:\s*([^;]+);/)?.[1]

    expect(darkAccent).toBeDefined()
    expect(lightAccent).toBeDefined()
    expect(stylesheet).toContain(`--accent: ${darkAccent}`)
    expect(stylesheet.split('{').length).toBe(stylesheet.split('}').length)
    expect(built.get('icon.svg')).toContain(String(lightAccent))
  })

  it('publishes a document that has commented a tag out, rather than refusing the page', () => {
    const parked = override(
      'docs/plan.md',
      '# Caroline implementation plan\n\n<!-- <img src="shot.png"> -->\n',
    )

    expect(() => buildSite(parked)).not.toThrow()
  })

  it('leaves no substitution marker unfilled', () => {
    for (const [, contents] of documents) expect(contents).not.toContain('{{')
  })

  // Criterion 2. The home page is the one page the site writes, and the one page that must not
  // become a second setup guide.
  describe('the home page', () => {
    const home = page('index.html')

    it('takes what Caroline is from the README rather than describing it again', () => {
      const lede = source('README.md').split('\n\n')[1] ?? ''

      expect(lede).not.toBe('')
      expect(text(home)).toContain(text(plain(lede)))
      // Written out rather than derived, because the assertion above computes the lede exactly as the
      // build does and so agrees with it about the wrong paragraph as readily as the right one.
      expect(text(home)).toContain('A single-user, self-hosted GTD system.')
    })

    /**
     * The paragraph is the README's, so a link in it is written relative to the README. Rendering it as
     * part of the home page's own file would resolve that link against `site/pages/`, and the build
     * would refuse a link the README is right about while naming a file that does not contain it.
     */
    it('resolves a link in that paragraph as the README, not as the page it is spliced into', () => {
      const readme = source('README.md')
      const linked = override(
        'README.md',
        readme.replace(
          'A single-user, self-hosted GTD system.',
          'A single-user, self-hosted GTD system, built in the order [the plan](docs/plan.md) gives.',
        ),
      )

      expect(buildSite(linked).get('index.html')).toContain('href="plan.html"')
    })

    /**
     * A Windows checkout with `core.autocrlf` set separates paragraphs with `\r\n\r\n`. Splitting on
     * `\n\n` there makes the whole README one block, and the home page loses the one paragraph it
     * borrows.
     */
    it('finds that paragraph on a checkout with either line ending', () => {
      const windows = override('README.md', source('README.md').replace(/\n/g, '\r\n'))

      expect(buildSite(windows).get('index.html')).toContain(
        'A single-user, self-hosted GTD system.',
      )
    })

    /**
     * The description of the front page is the one that is read most and seen least: it is what a search
     * result and a shared link show. It was the section about Node versions for two commits, because the
     * markers are filled before the page is described and the lede had become rendered HTML by then.
     */
    it('describes itself with what Caroline is, not with what it runs on', () => {
      const description = /<meta name="description" content="([^"]*)"/.exec(home)?.[1] ?? ''

      expect(description).toContain('A single-user, self-hosted GTD system.')
    })

    it('instructs nobody: no commands, and no environment variable to set', () => {
      expect(home).not.toContain('<pre')
      // Anything shaped like a variable name a reader would be told to export.
      expect(text(home)).not.toMatch(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/)
    })

    it('sends the reader to the setup guide instead', () => {
      expect(attributes(home, 'href')).toContain('setup.html')
    })

    it('says what Caroline will not do, which is half of deciding whether you want it', () => {
      expect(text(home)).toMatch(/never writes|writes nothing back|reads only/i)
    })
  })
})

describe('the links survive the move off GitHub', () => {
  // Criterion 3. The exit criterion of this milestone is a stranger getting from the front page to
  // a working install, and a link that lands nowhere is where that fails.
  it('resolves every internal link to a page that was built', () => {
    const dangling: string[] = []

    for (const [path, contents] of documents) {
      for (const href of attributes(contents, 'href')) {
        if (isExternal(href) || href.startsWith('#')) continue
        const [target = ''] = href.split('#')
        const resolved = posix.normalize(posix.join(posix.dirname(path), target))
        if (!built.has(resolved)) dangling.push(`${path} -> ${href}`)
      }
    }

    expect(dangling).toEqual([])
  })

  it('resolves every fragment to a heading on the page it names', () => {
    const dangling: string[] = []

    for (const [path, contents] of documents) {
      for (const href of attributes(contents, 'href')) {
        if (isExternal(href)) continue
        const [target = '', fragment] = href.split('#')
        if (fragment === undefined || fragment === '') continue
        const resolved =
          target === '' ? path : posix.normalize(posix.join(posix.dirname(path), target))
        const targetPage = built.get(resolved)
        if (targetPage === undefined || !identifiers(targetPage).has(fragment)) {
          dangling.push(`${path} -> ${href}`)
        }
      }
    }

    expect(dangling).toEqual([])
  })

  it('fails the build on a link that resolves to nothing, rather than shipping it', () => {
    const broken = override('docs/setup.md', '# Setting Caroline up\n\n[gone](nowhere.md)\n')

    expect(() => buildSite(broken)).toThrow(/nowhere\.md/)
  })

  /**
   * `marked` re-throws what a renderer throws with "Please report this to markedjs/marked" appended, and
   * the expected failure of this build is somebody's broken link. Being told to file a bug against a
   * Markdown library is a poor answer to a typo, so the failures are collected and thrown after the
   * parse, which also reports every bad link in a document rather than the first.
   */
  it('says what is wrong without sending anybody to a Markdown library to report it', () => {
    const broken = override(
      'docs/plan.md',
      '# Caroline implementation plan\n\n[one](nowhere.md) [two](alsonowhere.md)\n',
    )

    expect(() => buildSite(broken)).toThrow(/nowhere\.md/)
    expect(() => buildSite(broken)).toThrow(/alsonowhere\.md/)
    expect(() => buildSite(broken)).not.toThrow(/markedjs/)
  })

  /**
   * The shell owns one id, for its skip link. A heading slugging to the same thing would leave a
   * `#content` written against GitHub matching `<main>`, so a reader following it lands at the top of
   * the page rather than at the section, which is exactly what criterion 3 promises does not happen.
   */
  it.each(['[the guide]()', '[the guide](#)'])(
    'fails the build on %s, which is a typo rather than a link',
    (link) => {
      const broken = override('docs/plan.md', `# Caroline implementation plan\n\n${link}\n`)

      expect(() => buildSite(broken)).toThrow(/nothing to link to/)
    },
  )

  /** `## ???` slugs to nothing, which is `id=""` and a contents entry pointing at `#`. */
  it('fails the build on a heading that slugs to nothing at all', () => {
    const broken = override('docs/plan.md', '# Caroline implementation plan\n\n## ???\n')

    expect(() => buildSite(broken)).toThrow(/no identifier/)
  })

  it('fails the build on a heading whose identifier the page shell already owns', () => {
    const broken = override('docs/plan.md', '# Caroline implementation plan\n\n## Content\n')

    expect(() => buildSite(broken)).toThrow(/the page shell uses for its skip link/)
  })

  it('fails the build on a fragment no heading answers to', () => {
    const broken = override('docs/setup.md', '# Setting Caroline up\n\n[gone](#no-such-heading)\n')

    expect(() => buildSite(broken)).toThrow(/no-such-heading/)
  })

  /**
   * A fragment is everything after the first `#`, because that is what a browser asks for. Checking
   * only as far as a second one would pass `#4-a-model#gone`, whose target does not exist.
   */
  it('fails the build on a fragment that a second hash makes nothing', () => {
    const broken = override(
      'docs/setup.md',
      '# Setting Caroline up\n\n## 4. A model\n\n[gone](#4-a-model#gone)\n',
    )

    expect(() => buildSite(broken)).toThrow(/4-a-model#gone/)
  })

  // Criterion 4. The fragments are already written into the documents, and GitHub's slugs are what
  // they were written against.
  it('identifies headings by GitHub slug, so the fragments already written still land', () => {
    expect(slug('6b. The consent screen')).toBe('6b-the-consent-screen')
    // github-slugger trims before it drops punctuation, so the space a trailing `?` leaves becomes a
    // hyphen. Trimming afterwards would drop it and refuse a fragment GitHub is right about.
    expect(slug('What now ?')).toBe('what-now-')
    expect(slug('Non-goals')).toBe('non-goals')
    expect(slug('What leaves the machine, and what stays on it')).toBe(
      'what-leaves-the-machine-and-what-stays-on-it',
    )
    expect(page('setup.html')).toContain('id="6b-the-consent-screen"')
  })

  /**
   * GitHub slugs what a heading renders as, not what it is written as, so a heading carrying markup
   * is where the two can part company. A code span already worked; a link did not, and would have
   * failed the build on a fragment written against GitHub rather than landing on it.
   */
  it('slugs a heading from its rendered text, markup and entities included', () => {
    // The plan rather than the setup guide: other documents link into the guide's numbered steps by
    // fragment, and a stub of it would fail the build on their links rather than on this one's.
    const built = buildSite(
      override(
        'docs/plan.md',
        [
          '# Caroline implementation plan',
          '## See [the guide](content-policy.md)',
          '## APIs & Services',
          '## `caroline.config.json`',
          '[a](#see-the-guide) [b](#apis--services) [c](#carolineconfigjson)',
        ].join('\n\n'),
      ),
    )

    expect(built.get('plan.html')).toContain('id="see-the-guide"')
    expect(built.get('plan.html')).toContain('id="apis--services"')
    expect(built.get('plan.html')).toContain('id="carolineconfigjson"')
    // And the contents entry for that heading is a link with text in it, not a link with a link in
    // it: a browser closes the outer anchor at the inner one, so half the entry would stop pointing
    // at the fragment and the rest would leave the page from inside the contents list.
    expect(built.get('plan.html')).toContain('<li><a href="#see-the-guide">See the guide</a></li>')
  })

  /**
   * A link names a page of the site or it is a defect. There is no third answer, and there deliberately
   * is not: asking the filesystem whether an unpublished target existed made the build's verdict depend
   * on what happened to sit beside the checkout.
   */
  it.each(['../../gone.md', 'caroline.config.example.json'])(
    'fails the build on %s, which is no page of the site',
    (target) => {
      const broken = override(
        'docs/plan.md',
        `# Caroline implementation plan\n\n[out](${target})\n`,
      )

      expect(() => buildSite(broken)).toThrow(/no page of this site/)
    },
  )

  // Criterion 5. A project site is served under a path. A root-relative link is one that works on
  // the machine it was built on and nowhere else.
  it('references nothing absolutely, so the site works under a project path', () => {
    for (const [path, contents] of documents) {
      for (const reference of [...attributes(contents, 'href'), ...attributes(contents, 'src')]) {
        if (isExternal(reference) || reference.startsWith('#')) continue
        expect(reference, `${path} references ${reference}`).not.toMatch(/^\//)
      }
    }
  })

  it('links each page back to the document it renders, so a correction has somewhere to go', () => {
    for (const entry of sitePages()) {
      expect(page(entry.output)).toContain(entry.source)
    }
  })
})

describe('the site and the application look like one thing', () => {
  const stylesheet = page('styles.css')
  const application = source('web/styles.css')
  const declared = (css: string, context = '') =>
    declarations(css).filter(
      (rule) =>
        rule.selector === ':root' && rule.property.startsWith('--') && rule.context === context,
    )

  // Criterion 6. Extracted, not copied: a second palette is a palette that drifts.
  it.each([
    { theme: 'dark', context: '' },
    { theme: 'light', context: '@media (prefers-color-scheme: light)' },
  ])('declares every $theme token the application declares, at the same value', ({ context }) => {
    const expected = declared(application, context)

    expect(expected.length).toBeGreaterThan(5)
    for (const token of expected) {
      expect(declared(stylesheet, context)).toEqual(
        expect.arrayContaining([expect.objectContaining({ property: token.property })]),
      )
      expect(
        declared(stylesheet, context).find((rule) => rule.property === token.property)?.value,
      ).toBe(token.value)
    }
  })

  /**
   * The `:root`-scoped check above is blind to a custom property redeclared under a narrower
   * selector, and the "named only as a token" check below is blind to it too, because that one
   * only inspects non-`--`-prefixed properties. A `.hero`-style pin that redefines a token for one
   * subtree, in literal values that happen to match today, would slip past both. Reading every
   * custom-property declaration in the built stylesheet, wherever it sits, and checking it against
   * the value the application actually declares for that token is what a hand-copied pin fails and
   * a generated one, such as `heroPin` in site/build.ts, passes.
   */
  it('redeclares no token under a narrower selector without the value still coming from the application', () => {
    const dark = declared(application, '')
    const scoped = declarations(stylesheet).filter(
      (rule) => rule.selector !== ':root' && rule.property.startsWith('--'),
    )

    expect(scoped.length).toBeGreaterThan(0)
    for (const rule of scoped) {
      const token = dark.find((candidate) => candidate.property === rule.property)
      expect(token, `${rule.property}, redeclared on ${rule.selector}`).toBeDefined()
      expect(rule.value, `${rule.property}, redeclared on ${rule.selector}`).toBe(token?.value)
    }
  })

  // Spec 10's first two criteria, applied to the second stylesheet: the scales are only scales
  // while something fails on a value that is not on them.
  const own = declarations(source('site/styles.css')).filter(
    (rule) => !rule.property.startsWith('--'),
  )

  /**
   * A token renamed in `web/styles.css` but not in `site/styles.css`'s hand-maintained rules is a
   * rule that resolves against nothing: the browser silently falls through to the property's
   * initial value, which is not a build failure and not a lint failure either, so nothing else
   * catches it. Checking every `var(--x)` this stylesheet writes against the names the palette
   * above actually extracts is what makes that class of drift a test failure instead.
   */
  it('references only tokens the application actually declares, so a rename cannot leave a rule pointing at nothing', () => {
    const declaredTokens = new Set([
      ...declared(application, '').map((rule) => rule.property),
      ...declared(application, '@media (prefers-color-scheme: light)').map((rule) => rule.property),
    ])

    const referenced = new Set<string>()
    for (const rule of own) {
      for (const match of rule.value.matchAll(/var\((--[a-z0-9-]+)/g)) {
        const token = match[1]
        if (token !== undefined) referenced.add(token)
      }
    }

    expect(referenced.size).toBeGreaterThan(5)
    for (const token of referenced) {
      expect(declaredTokens, `${token}, referenced in site/styles.css`).toContain(token)
    }
  })
  const exempt = new Set(['0', 'auto', 'inherit', 'initial', 'unset', 'none', '100%'])
  const tokenised = (value: string): boolean =>
    value.split(/\s+/).every((part) => exempt.has(part) || part.startsWith('var(--'))

  it('has rules of its own to check, so a parse failure cannot pass as a clean sheet', () => {
    expect(own.length).toBeGreaterThan(40)
  })

  it('spaces, sizes and rounds everything from the scales', () => {
    const properties =
      /^(margin|padding)(-(top|right|bottom|left))?$|^(gap|row-gap|column-gap)$|^font-size$|^border-radius$/

    expect(own.filter((rule) => properties.test(rule.property) && !tokenised(rule.value))).toEqual(
      [],
    )
  })

  it('names a colour only as a token, so no rule is right in one theme alone', () => {
    const properties =
      /^(color|background|background-color|border|border-(top|right|bottom|left)|border-color|outline|box-shadow|fill|stroke)$/
    const literals = own.filter(
      (rule) =>
        properties.test(rule.property) &&
        !rule.value.includes('var(') &&
        // A removed border and a removed shadow are the absence of a colour rather than one.
        !['transparent', 'inherit', 'none', '0'].includes(rule.value),
    )

    expect(literals).toEqual([])
  })

  /**
   * A sticky header and a fragment link are the two halves of the same problem: scrolling a heading to
   * the top of the viewport puts it behind the header, so the reader arrives at the paragraph after the
   * heading. Criterion 4 says the fragments land, and under the furniture is not landing.
   */
  it('leaves room under the sticky header for a heading a fragment scrolls to', () => {
    const offsets = own.filter((rule) => rule.property === 'scroll-margin-top')

    expect(offsets).not.toEqual([])
    expect(offsets.map((rule) => rule.selector)).toContain('h1, h2, h3')
  })

  it('draws the icon in the accent colour the application uses, rather than a fourth blue', () => {
    // The icon takes the light pair (see `icon` in site/build.ts), so this compares against the
    // light override rather than the dark default `--accent` now is.
    const accent = declared(application, '@media (prefers-color-scheme: light)').find(
      (rule) => rule.property === '--accent',
    )?.value

    expect(accent).toBeDefined()
    expect(page('icon.svg')).toContain(String(accent))
  })

  /**
   * A browser tab is drawn from a cached image and knows nothing about the reader's theme, so the icon
   * takes the light pair. It should take it because it is the light pair, not because that palette is
   * written first: reordering the file should not repaint the favicon.
   */
  it('takes the icon colours from the light palette wherever it is written', () => {
    // Issue #47 made dark the unconditioned default, so the light palette is now the media-query
    // block; moving it ahead of `:root` must not change which pair the icon draws from.
    const light =
      /@media \(prefers-color-scheme: light\) \{\s*:root \{[^}]*\}\s*\}/.exec(application)?.[0] ??
      ''
    const reordered = override('web/styles.css', `${light}\n${application.replace(light, '')}`)
    const lightAccent = declared(application, '@media (prefers-color-scheme: light)').find(
      (rule) => rule.property === '--accent',
    )?.value

    expect(light).not.toBe('')
    expect(lightAccent).toBeDefined()
    expect(buildSite(reordered).get('icon.svg')).toContain(String(lightAccent))
  })
})

describe('the site asks nothing of the reader', () => {
  // Criterion 7. A documentation site that needs a script to be read is worse at its job, and every
  // external request is a record of somebody reading it.
  it('runs no script', () => {
    for (const [path, contents] of documents) {
      expect(contents, path).not.toContain('<script')
      expect(contents, path).not.toMatch(/\son[a-z]+="/)
    }
  })

  /**
   * Enforced by the build and not only asserted here, because a document's raw HTML passes through the
   * renderer untouched: a script that got in there would be published and noticed afterwards. The
   * build refuses rather than sanitising, for the reason `site/build.ts` gives.
   */
  it('fails the build on a page carrying a script, rather than stripping it and shipping', () => {
    const broken = override('docs/setup.md', '# Setting Caroline up\n\n<script>alert(1)</script>\n')

    expect(() => buildSite(broken)).toThrow(/which a page of this site does not/)
  })

  it('fails the build on a link whose scheme makes it code', () => {
    const broken = override(
      'docs/setup.md',
      '# Setting Caroline up\n\n[press](javascript:alert(1))\n',
    )

    expect(() => buildSite(broken)).toThrow(/scheme this site does not link out with/)
  })

  /**
   * A document's raw HTML reaches the page untouched, so the check reads every spelling of the
   * attribute rather than the one this generator writes. Upper case, single quotes, a space either
   * side of the equals sign, and no quotes at all.
   */
  it.each([
    `<a HREF='javascript:alert(1)'>press</a>`,
    `<a href = "javascript:alert(1)">press</a>`,
    `<a href=javascript:alert(1)>press</a>`,
  ])('fails the build on %s, however the attribute is written', (anchor) => {
    const broken = override('docs/setup.md', `# Setting Caroline up\n\n${anchor}\n`)

    expect(() => buildSite(broken)).toThrow(/scheme this site does not link out with/)
  })

  /**
   * The check reads tags, not the page, so a document that shows an anchor in a code sample is
   * published rather than failing the build on a link nobody wrote. Spec 11 itself discusses the
   * spellings of the attribute, which is how this would have been found the hard way.
   */
  it('publishes a document that writes about an href without mistaking it for one', () => {
    const showing = override(
      'docs/plan.md',
      '# Caroline implementation plan\n\n```html\n<a href="https://example.com/">x</a>\n```\n',
    )

    expect(() => buildSite(showing)).not.toThrow()
  })

  /**
   * `docs/images` is copied and nothing else is, so an image from anywhere else would render as a
   * request for a file that is not there. The build says where the file belongs rather than leaving a
   * reader's first visit to discover it.
   */
  it('fails the build on an image it publishes no file for', () => {
    const broken = override(
      'docs/setup.md',
      '# Setting Caroline up\n\n![a shot](../web/styles.css)\n',
    )

    expect(() => buildSite(broken)).toThrow(/no published image/)
  })

  /** A fragment on an image is a palette or a mistake, and a browser can do nothing with the mistake. */
  it('fails the build on an image asking for part of a PNG', () => {
    const broken = override(
      'docs/using.md',
      '# Using Caroline\n\n![a shot](images/board.png#the-middle-bit)\n',
    )

    expect(() => buildSite(broken)).toThrow(/is not a palette/)
  })

  /** Raw HTML reaches the page untouched, so the renderer reading a Markdown image is half of it. */
  it('fails the build on a raw image, wherever it would be fetched from', () => {
    for (const [image, complaint] of [
      [`<img src='shot.png' alt="x">`, /which the build did not produce/],
      [`<img src="https://elsewhere.test/x.png">`, /fetches nothing from another host/],
    ] as const) {
      const broken = override('docs/plan.md', `# Caroline implementation plan\n\n${image}\n`)

      expect(() => buildSite(broken)).toThrow(complaint)
    }
  })

  it('refuses an external asset in a document, not only an external link', () => {
    const broken = override(
      'docs/plan.md',
      `# Caroline implementation plan\n\n<source src='data:audio/mp3,x'>\n`,
    )

    expect(() => buildSite(broken)).toThrow(/scheme this site does not link out with/)
  })

  /**
   * Two spellings of a handler, refused by two different mechanisms, both probed rather than reasoned
   * about. `ONCLICK` is an attribute and is read as one. An attribute abutting the quote before it is not
   * a tag `marked` will pass through, so the whole thing is escaped and reaches the page as text a
   * browser prints rather than runs: the guarantee holds either way, and which way is worth pinning,
   * because "the build refuses it" and "it never becomes a tag" fail differently if either changes.
   */
  it('never publishes a handler, whether it is refused or escaped', () => {
    const shouting = override(
      'docs/plan.md',
      `# Caroline implementation plan\n\n<a href="plan.html" ONCLICK="alert(1)">x</a>\n`,
    )
    const abutting = override(
      'docs/plan.md',
      `# Caroline implementation plan\n\n<a href="plan.html"onclick="alert(1)">x</a>\n`,
    )

    expect(() => buildSite(shouting)).toThrow(/runs nothing/)
    expect(buildSite(abutting).get('plan.html')).toContain(
      '&lt;a href=&quot;plan.html&quot;onclick=',
    )
  })

  /**
   * A quoted attribute value may contain a `>`, so a tag pattern that ends at the first one ends this
   * tag at its title and never reads its href: the one tag somebody would write to get a link past the
   * scheme check, and the same defect in the inline-handler check beside it.
   */
  it('reads a whole tag, including a quoted angle bracket, before enforcing anything', () => {
    const link = override(
      'docs/plan.md',
      `# Caroline implementation plan\n\n<a title=">" href="javascript:alert(1)">press</a>\n`,
    )
    const handler = override(
      'docs/plan.md',
      `# Caroline implementation plan\n\n<span title=">" onclick="alert(1)">press</span>\n`,
    )

    expect(() => buildSite(link)).toThrow(/scheme this site does not link out with/)
    expect(() => buildSite(handler)).toThrow(/runs nothing/)
  })

  /**
   * Criterion 7 is about what a page fetches as it loads, which is not the same question as what a
   * reader may click. An anchor may leave the site; a stylesheet, a font, an image or an embedded object
   * from another host is a request the reader did not make and a record of them having read the page.
   */
  it.each([
    `<link rel="stylesheet" href="https://cdn.test/x.css">`,
    `<video poster='https://cdn.test/x.png'></video>`,
  ])('fails the build on %s, which fetches from another host', (tag) => {
    const broken = override('docs/plan.md', `# Caroline implementation plan\n\n${tag}\n`)

    expect(() => buildSite(broken)).toThrow(/fetches nothing from another host/)
  })

  it.each([
    '<style>@import url(https://cdn.test/x.css);</style>',
    '<object data="x.svg"></object>',
  ])('fails the build on %s, which is a page doing more than being read', (tag) => {
    const broken = override('docs/plan.md', `# Caroline implementation plan\n\n${tag}\n`)

    expect(() => buildSite(broken)).toThrow(/which a page of this site does not/)
  })

  /**
   * A root-relative reference normalises into one that resolves against the output and points at another
   * site entirely once this one is served under a path, which is criterion 5 and the one spelling of it
   * that looked correct.
   */
  it.each([`<a href="/index.html">x</a>`, `<a href='/index.html'>x</a>`])(
    'fails the build on %s rather than publishing a link off the site',
    (anchor) => {
      const broken = override('docs/plan.md', `# Caroline implementation plan\n\n${anchor}\n`)

      expect(() => buildSite(broken)).toThrow(/root-relative rather than relative/)
    },
  )

  /** An address is a leak whether it is in a paragraph or behind a scheme. */
  it('fails the build on a link that is an address', () => {
    const broken = override(
      'docs/setup.md',
      '# Setting Caroline up\n\n[ask](mailto:nobody@example.com)\n',
    )

    expect(() => buildSite(broken)).toThrow(/scheme this site does not link out with/)
  })

  it('fetches nothing from another host: no font, no stylesheet, no image', () => {
    for (const [path, contents] of documents) {
      for (const tag of contents.match(/<(link|img|iframe|source)[^>]*>/g) ?? []) {
        expect(tag, path).not.toMatch(/(href|src)="[a-z]+:/)
      }
    }
    expect(page('styles.css')).not.toMatch(/@import|url\(\s*['"]?[a-z]+:/)
  })

  // Criterion 10. The same shell everywhere, and a title that says which page you are on.
  it('titles every page and navigates every page the same way', () => {
    const navigation = (html: string) =>
      text(html.match(/<nav class="site-nav"[\s\S]*?<\/nav>/)?.[0] ?? '')
    const first = navigation(page('index.html'))

    expect(first).not.toBe('')
    for (const [path, contents] of documents) {
      expect(contents, path).toMatch(/<title>[^<]+<\/title>/)
      expect(navigation(contents), path).toBe(first)
    }
  })

  /**
   * Found by reading the built site rather than by reading the code: the specs index has two
   * headings, so it gets no contents list, and the two-column layout put it in the fifteen-rem
   * column with two thirds of the window empty beside it.
   */
  it('gives the column beside the document only to a page that has a contents list', () => {
    expect(page('setup.html')).toContain('class="toc"')
    expect(page('setup.html')).toContain('with-contents')
    expect(page('specs/index.html')).not.toContain('class="toc"')
    expect(page('specs/index.html')).not.toContain('with-contents')

    // Scoped to `main`'s own rules: the extra columns belong to `main.with-contents`, `.with-sidebar`
    // and their combination, and not to the unrelated card grids elsewhere in this stylesheet that
    // also happen to be `grid-template-columns` rules.
    const layout = declarations(source('site/styles.css')).filter(
      (rule) => rule.property === 'grid-template-columns' && rule.selector.startsWith('main'),
    )

    expect(layout.map((rule) => rule.selector)).toEqual([
      'main.with-contents',
      'main.with-sidebar',
      'main.with-sidebar.with-contents',
    ])
  })

  it('reaches every page from the home page in at most two links', () => {
    const outward = (path: string) =>
      attributes(page(path), 'href')
        .filter((href) => !isExternal(href))
        .map((href) => posix.normalize(posix.join(posix.dirname(path), href.split('#')[0] ?? '')))
        .filter((target) => built.has(target) && target.endsWith('.html'))
    const reached = new Set(['index.html'])
    for (const first of outward('index.html')) {
      reached.add(first)
      for (const second of outward(first)) reached.add(second)
    }

    expect([...documents.map(([path]) => path)].filter((path) => !reached.has(path))).toEqual([])
  })
})

describe('the site publishes nothing but the documentation', () => {
  // Criterion 8. The repository is public, so anything the site renders is public, and the site is
  // the surface where a fixture or a data file would be published without anybody deciding to.
  it('renders no file outside the README, the docs and the site itself', () => {
    for (const entry of sitePages()) {
      expect(entry.source).toMatch(/^(README\.md|docs\/|site\/)/)
    }
  })

  /**
   * The whole page and not its visible text: an address in a `mailto:` href is published exactly as
   * much as one in a paragraph, and reading only what a reader sees would miss it. That is also why
   * `mailto:` is not a scheme the build will link out over.
   */
  it('carries no address and nothing shaped like a key or a token, in text or in an attribute', () => {
    for (const [path, contents] of documents) {
      for (const reading of [text(contents), contents]) {
        expect(reading, path).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/)
        expect(reading, path).not.toMatch(
          /\b(gh[pousr]_|github_pat_|sk-[A-Za-z]|AIza)[A-Za-z0-9_-]+/,
        )
      }
    }
  })

  // Criterion 9. A generator that reads the clock or the environment produces a diff nobody made.
  it('builds the same bytes twice', () => {
    expect([...buildSite()]).toEqual([...buildSite()])
  })
})

describe('publishing it', () => {
  /**
   * The comments come out first, and the assertions read what is left. Both workflows explain
   * themselves in prose that names the very strings these tests look for, so asserting against the
   * raw file would let a comment stand in for the configuration it describes: the `id-token: write`
   * assertion passed on a comment about `id-token: write` before this.
   */
  const configured = (path: string) => source(path).replace(/(^|\n)\s*#[^\n]*/g, '$1')
  const workflow = configured('.github/workflows/pages.yml')

  // Criterion 11. The workflow that deploys the site can mint a Pages token and cannot write to the
  // repository, which is the whole of what it needs.
  it('deploys on a push to main and on demand', () => {
    expect(workflow).toMatch(/push:\s*\n\s*branches: \[main\]/)
    expect(workflow).toContain('workflow_dispatch:')
  })

  it('takes the Pages permissions and no write access to the repository', () => {
    expect(workflow).toContain('pages: write')
    expect(workflow).toContain('id-token: write')
    expect(workflow).toContain('contents: read')
    expect(workflow).not.toContain('contents: write')
  })

  it('builds the site by the same command a person would run', () => {
    const scripts = JSON.parse(source('package.json')).scripts as Record<string, string>

    expect(scripts['build:site']).toBeDefined()
    expect(workflow).toContain('npm run build:site')
    // And the pull request that changes the site proves it still builds, before it is merged.
    expect(configured('.github/workflows/ci.yml')).toContain('npm run build:site')
  })
})

/** The repository as it is, with one file replaced: enough to test what the build refuses. */
function override(path: string, contents: string): SiteSources {
  const real = repositorySources(root)

  return {
    read: (requested) => (requested === path ? contents : real.read(requested)),
    list: (requested) => real.list(requested),
  }
}

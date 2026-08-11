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
import { buildSite, pages, repositorySources, slug, type SiteSources } from '../../site/build.js'
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

function attributes(html: string, attribute: 'href' | 'src'): string[] {
  return [...html.matchAll(new RegExp(`${attribute}="([^"]*)"`, 'g'))].map(
    (match) => match[1] ?? '',
  )
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
  it.each(pages.filter((entry) => entry.source !== 'site/pages/index.md'))(
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

  it('fails the build on a link that climbs out of the repository', () => {
    const broken = override(
      'docs/plan.md',
      '# Caroline implementation plan\n\n[out](../../gone.md)\n',
    )

    expect(() => buildSite(broken)).toThrow(/outside the repository/)
  })

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
    for (const entry of pages) {
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
    { theme: 'light', context: '' },
    { theme: 'dark', context: '@media (prefers-color-scheme: dark)' },
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

  // Spec 10's first two criteria, applied to the second stylesheet: the scales are only scales
  // while something fails on a value that is not on them.
  const own = declarations(source('site/styles.css')).filter(
    (rule) => !rule.property.startsWith('--'),
  )
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
   * `.flow-box rect` is a class and an element, and `.flow-core` is a class: the accent stroke lost to
   * the neutral one on specificity rather than on source order, so the box the diagram is about was
   * outlined like the seven around it. The selector has to name the element to outrank it.
   */
  it('outlines the middle of the diagram in the accent rather than losing to the box rule', () => {
    const accent = own.find(
      (rule) => rule.property === 'stroke' && rule.value === 'var(--accent)',
    )?.selector

    expect(accent).toBeDefined()
    expect(accent).toContain('rect')
  })

  it('draws the icon in the accent colour the application uses, rather than a fourth blue', () => {
    const accent = declared(application).find((rule) => rule.property === '--accent')?.value

    expect(accent).toBeDefined()
    expect(page('icon.svg')).toContain(String(accent))
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

    expect(() => buildSite(broken)).toThrow(/runs nothing/)
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
   * No asset is copied into the output, so an image would render as a request for a file that is not
   * there. The build says so rather than publishing it, because a reader's first visit is a poor time
   * to discover it and `verify` reads links rather than images.
   */
  it('fails the build on an image, which the site has nothing to serve for', () => {
    const broken = override(
      'docs/setup.md',
      '# Setting Caroline up\n\n![a shot](images/shot.png)\n',
    )

    expect(() => buildSite(broken)).toThrow(/copies no assets/)
  })

  it('refuses an external asset in a document, not only an external link', () => {
    const broken = override(
      'docs/plan.md',
      `# Caroline implementation plan\n\n<img src='data:image/svg+xml,x' alt="x">\n`,
    )

    expect(() => buildSite(broken)).toThrow(/scheme this site does not link out with/)
  })

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

    const layout = declarations(source('site/styles.css')).filter(
      (rule) => rule.property === 'grid-template-columns',
    )

    expect(layout.map((rule) => rule.selector)).toEqual(['main.with-contents'])
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
    for (const entry of pages) {
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
    exists: (requested) => requested === path || real.exists(requested),
    list: (requested) => real.list(requested),
  }
}

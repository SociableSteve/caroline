/**
 * The public site. Spec 11.
 *
 * The site is a shell around documentation that already exists. Every page but the home page is a
 * Markdown file from the repository, rendered, with the links between those files rewritten to the
 * pages that render them. Nothing here writes prose, because a setup guide maintained in two places
 * is a setup guide that is wrong in one of them.
 *
 * Three things it does that a Markdown-to-HTML call does not:
 *
 * - **Rewrites the links.** The documents link to each other by file path, and a fragment such as
 *   `#6b-the-consent-screen` was written against GitHub's heading slugs. Both have to keep working
 *   somewhere those paths do not exist, and a link that resolves to nothing fails the build.
 * - **Borrows the application's palette.** The tokens are extracted from `web/styles.css` rather
 *   than copied, so there is one palette and not two that drift.
 * - **Returns its output instead of writing it.** `site/main.ts` writes the map to disk; the suite
 *   asserts against it in memory, which is how every page can be compared with its source without a
 *   temporary directory to clean up.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, posix } from 'node:path'
import { Marked, type Tokens } from 'marked'

/** Where the repository's files come from. A parameter so the suite can build a broken tree. */
export interface SiteSources {
  read(repositoryPath: string): string
  exists(repositoryPath: string): boolean
  list(repositoryPath: string): string[]
}

export interface SitePage {
  /** The Markdown file this page renders, relative to the repository root. */
  readonly source: string
  /** Where the page is written, relative to the site root. */
  readonly output: string
  /** The `<title>`, and what the page is called wherever it is named. */
  readonly title: string
}

export function repositorySources(root: string = process.cwd()): SiteSources {
  return {
    read: (repositoryPath) => readFileSync(join(root, repositoryPath), 'utf8'),
    exists: (repositoryPath) => existsSync(join(root, repositoryPath)),
    list: (repositoryPath) => readdirSync(join(root, repositoryPath)).sort(),
  }
}

/**
 * The navigation, and the whole of it. Five entries: where you are, the one thing most readers came
 * for, the documents, the contract behind them, and the source. The content policy and the reference
 * are a link away from the documentation index, which is that index's job.
 */
const navigation = [
  { label: 'Home', output: 'index.html' },
  { label: 'Setup', output: 'setup.html' },
  { label: 'Documentation', output: 'docs.html' },
  { label: 'Specs', output: 'specs/index.html' },
] as const

/**
 * The pages that are not specs. The specs are read from the directory instead, so a spec added
 * later is published by adding the spec.
 */
const fixedPages: readonly SitePage[] = [
  { source: 'site/pages/index.md', output: 'index.html', title: 'Caroline' },
  { source: 'docs/setup.md', output: 'setup.html', title: 'Setting Caroline up' },
  {
    source: 'docs/content-policy.md',
    output: 'content-policy.html',
    title: 'What leaves the machine',
  },
  { source: 'docs/README.md', output: 'docs.html', title: 'Documentation' },
  { source: 'README.md', output: 'reference.html', title: 'Caroline in short' },
  { source: 'docs/plan.md', output: 'plan.html', title: 'Implementation plan' },
  { source: 'docs/specs/README.md', output: 'specs/index.html', title: 'Specs' },
]

function manifest(sources: SiteSources): readonly SitePage[] {
  const specs = sources
    .list('docs/specs')
    .filter((name) => /^\d\d-.*\.md$/.test(name))
    .map((name) => ({
      source: `docs/specs/${name}`,
      output: `specs/${name.replace(/\.md$/, '.html')}`,
      title: headingOf(sources.read(`docs/specs/${name}`)),
    }))

  return [...fixedPages, ...specs]
}

/** The pages of the repository as it stands, which is what the suite asserts against. */
export const pages: readonly SitePage[] = manifest(repositorySources())

/** The first `#` heading of a document: what the document calls itself. */
function headingOf(markdown: string): string {
  return (/^# (.+)$/m.exec(markdown)?.[1] ?? 'Caroline').trim()
}

/**
 * GitHub's heading slug, because the fragments in the documents were written against it: lowercased,
 * punctuation dropped, spaces hyphenated. `## 6b. The consent screen` is `#6b-the-consent-screen`
 * here exactly as it is there.
 */
export function slug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .trim()
    .replace(/\s/g, '-')
}

const escapeText = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escapeAttribute = (value: string): string => escapeText(value).replace(/"/g, '&quot;')
const isAbsolute = (href: string): boolean =>
  /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')

/**
 * The repository, from `package.json`, so the one place that already names it stays the only one. It
 * is where a link to a file the site does not publish goes, and where the footer sends a reader who
 * wants to correct a page.
 */
function repositoryUrl(sources: SiteSources): string {
  const url = String(JSON.parse(sources.read('package.json')).repository?.url ?? '')
  const slugged = /github\.com[/:]([^/]+\/[^/.]+)/.exec(url)?.[1]
  if (slugged === undefined) throw new Error('package.json names no GitHub repository to link to')

  return `https://github.com/${slugged}`
}

interface Rendered {
  readonly html: string
  /** The `h2`s, in order: the table of contents of a long document. */
  readonly sections: readonly { readonly id: string; readonly label: string }[]
}

function render(markdown: string, page: SitePage, context: BuildContext): Rendered {
  const identifiers = new Set<string>()
  const sections: { id: string; label: string }[] = []
  const marked = new Marked({ gfm: true })

  marked.use({
    renderer: {
      heading(token: Tokens.Heading) {
        const label = this.parser.parseInline(token.tokens)
        let id = slug(token.text)
        // Two headings can say the same thing. GitHub numbers the repeats, and so does this.
        for (let repeat = 1; identifiers.has(id); repeat += 1) id = `${slug(token.text)}-${repeat}`
        identifiers.add(id)
        if (token.depth === 2) sections.push({ id, label })

        return `<h${token.depth} id="${escapeAttribute(id)}">${label}</h${token.depth}>\n`
      },

      link(token: Tokens.Link) {
        const href = resolve(token.href, page, context)
        const title = token.title == null ? '' : ` title="${escapeAttribute(token.title)}"`
        const external = isAbsolute(href) ? ' rel="noopener" target="_blank"' : ''

        return `<a href="${escapeAttribute(href)}"${title}${external}>${this.parser.parseInline(token.tokens)}</a>`
      },
    },
  })

  // The troubleshooting table is wider than a phone, and a table cell holds links of its own, so the
  // scroll box is wrapped round the rendered table rather than round a second rendering of it.
  const html = marked
    .parse(markdown, { async: false })
    .replaceAll('<table>', '<div class="table-scroll"><table>')
    .replaceAll('</table>', '</table></div>')

  return { html, sections }
}

/**
 * A link, from the file that holds it to the page that renders its target. Three answers: a page of
 * the site, a file in the repository that the site does not publish, or a defect.
 */
function resolve(href: string, page: SitePage, context: BuildContext): string {
  if (isAbsolute(href) || href.startsWith('#')) return href

  const [path = '', ...rest] = href.split('#')
  const fragment = rest.length === 0 ? '' : `#${rest.join('#')}`
  if (path === '') return href

  const target = posix.normalize(posix.join(posix.dirname(page.source), path))
  const output = context.outputs.get(target)
  if (output !== undefined) {
    return `${posix.relative(posix.dirname(page.output), output)}${fragment}`
  }
  if (context.sources.exists(target)) {
    return `${context.repository}/blob/main/${target}${fragment}`
  }

  throw new Error(
    `${page.source} links to ${href}, which is neither a page of the site nor a file in the repository`,
  )
}

interface BuildContext {
  readonly sources: SiteSources
  /** Repository path to site path, which is what makes a link between two documents a link. */
  readonly outputs: ReadonlyMap<string, string>
  readonly repository: string
}

/**
 * The site's own prose, and the only page not rendered from a document: what Caroline is, whether
 * you want it, and where to start. `{{lede}}` is the README's opening, so the answer to "what is
 * this" is written once, and `{{diagram}}` is the one picture.
 */
function homePage(markdown: string, context: BuildContext): string {
  const lede = (context.sources.read('README.md').split('\n\n')[1] ?? '').trim()
  if (lede === '')
    throw new Error('the README has no opening paragraph for the home page to render')

  return markdown
    .replace('{{lede}}', lede)
    .replace('{{diagram}}', diagram)
    .replace('{{start}}', actions(context))
}

/**
 * The two things to do next, at the top rather than at the foot: a reader who has decided is not
 * going to scroll to find out where to go. The pages are looked up in the manifest rather than named
 * here, and the home page is at the site root, so a page's output path is already its href.
 */
function actions(context: BuildContext): string {
  const link = (source: string, label: string, attributes = '') => {
    const output = context.outputs.get(source)
    if (output === undefined) throw new Error(`the home page cannot link to ${source}`)

    return `<a${attributes} href="${output}">${label}</a>`
  }

  return `<p class="actions">
  ${link('docs/setup.md', 'Set it up', ' class="primary"')}
  ${link('docs/README.md', 'Read the documentation')}
</p>`
}

/**
 * Three sources in, one direction, nothing out. The arrowheads are the point of the picture: the one
 * fact that decides whether somebody wants this is that it never writes to the accounts it reads.
 *
 * `aria-hidden`, and the same three groupings are stated in the text beside it, because a diagram is
 * not a way of telling somebody something.
 */
const diagram = `<svg class="flow" viewBox="0 0 640 190" aria-hidden="true" focusable="false">
  <g class="flow-box">
    <rect x="1" y="10" width="150" height="40" rx="8" />
    <rect x="1" y="70" width="150" height="40" rx="8" />
    <rect x="1" y="130" width="150" height="40" rx="8" />
    <rect class="flow-core" x="245" y="55" width="150" height="70" rx="8" />
    <rect x="489" y="10" width="150" height="40" rx="8" />
    <rect x="489" y="70" width="150" height="40" rx="8" />
    <rect x="489" y="130" width="150" height="40" rx="8" />
  </g>
  <g class="flow-label">
    <text x="76" y="35">GitHub</text>
    <text x="76" y="95">Gmail</text>
    <text x="76" y="155">Calendar</text>
    <text x="320" y="83">Caroline</text>
    <text class="flow-quiet" x="320" y="103">on your machine</text>
    <text x="564" y="35">Board</text>
    <text x="564" y="95">Daily plan</text>
    <text x="564" y="155">Chat</text>
  </g>
  <g class="flow-arrow">
    <path d="M151 30 H200 V70 H240" />
    <path d="M151 90 H240" />
    <path d="M151 150 H200 V110 H240" />
    <path d="M395 70 H440 V30 H484" />
    <path d="M395 90 H484" />
    <path d="M395 110 H440 V150 H484" />
  </g>
  <g class="flow-head">
    <path d="M240 70 l-7 -4 v8 z" />
    <path d="M240 90 l-7 -4 v8 z" />
    <path d="M240 110 l-7 -4 v8 z" />
    <path d="M484 30 l-7 -4 v8 z" />
    <path d="M484 90 l-7 -4 v8 z" />
    <path d="M484 150 l-7 -4 v8 z" />
  </g>
</svg>`

/** The first paragraph, as plain text: what a search result or a shared link shows. */
function description(markdown: string): string {
  const paragraph = markdown
    .split('\n\n')
    .map((block) => block.trim())
    .find((block) => block !== '' && !block.startsWith('#') && !block.startsWith('|'))
  const sentence = (paragraph ?? '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (sentence.length <= 160) return sentence

  // A whole sentence where the paragraph offers one within the length, and a whole word otherwise.
  // Cutting mid-word is how a description ends up reading as a truncated database column.
  const stop = sentence.slice(0, 161).lastIndexOf('. ')
  if (stop >= 60) return sentence.slice(0, stop + 1)

  return `${sentence.slice(0, sentence.lastIndexOf(' ', 157))}…`
}

function layout(
  page: SitePage,
  rendered: Rendered,
  markdown: string,
  context: BuildContext,
): string {
  // Every reference on the page, asset or page, is relative to this page: a project site is served
  // under a path, and a root-relative link is one that works on the machine it was built on.
  const href = (output: string) => posix.relative(posix.dirname(page.output), output)
  const links = navigation
    .map((entry) => {
      const current = entry.output === page.output ? ' aria-current="page"' : ''
      return `<a href="${escapeAttribute(href(entry.output))}"${current}>${entry.label}</a>`
    })
    .join('\n        ')
  const contents =
    rendered.sections.length < 3 || page.output === 'index.html'
      ? ''
      : `<nav class="toc" aria-label="On this page">
        <h2>On this page</h2>
        <ol>
          ${rendered.sections
            .map(
              (section) =>
                `<li><a href="#${escapeAttribute(section.id)}">${section.label}</a></li>`,
            )
            .join('\n          ')}
        </ol>
      </nav>`
  const title = page.output === 'index.html' ? 'Caroline' : `${page.title} · Caroline`

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeText(title)}</title>
    <meta name="description" content="${escapeAttribute(description(markdown))}" />
    <link rel="icon" href="${href('icon.svg')}" type="image/svg+xml" />
    <link rel="stylesheet" href="${href('styles.css')}" />
  </head>
  <body>
    <a class="skip" href="#content">Skip to the content</a>
    <header class="site-header">
      <a class="wordmark" href="${escapeAttribute(href('index.html'))}">Caroline</a>
      <nav class="site-nav" aria-label="Site">
        ${links}
        <a href="${escapeAttribute(context.repository)}" rel="noopener" target="_blank">Source</a>
      </nav>
    </header>
    <main id="content" class="${page.output === 'index.html' ? 'home' : 'document'}${contents === '' ? '' : ' with-contents'}">
      ${contents}
      <article>
${rendered.html.trimEnd()}
      </article>
    </main>
    <footer class="site-footer">
      <p>
        This page is
        <a href="${escapeAttribute(`${context.repository}/blob/main/${page.source}`)}" rel="noopener" target="_blank"><code>${escapeText(page.source)}</code></a>
        in the repository, rendered. Corrections belong to the file rather than to the site.
      </p>
      <p>Caroline is MIT-licensed, single-user, and runs on your own machine.</p>
    </footer>
  </body>
</html>
`
}

/**
 * The application's palette, lifted whole. Spec 10 owns these values; the site is a second set of
 * rules over the same tokens, and extracting the blocks is what stops it becoming a second palette.
 */
function palette(application: string): string {
  const blocks = [':root {', '@media (prefers-color-scheme: dark) {']
    .map((opening) => block(application, opening))
    .join('\n\n')

  return `/*
 * Extracted from web/styles.css by site/build.ts. Spec 10 decides these values, and the site and the
 * application share them so that they read as one piece of work. Edit them there.
 */
${blocks}
`
}

/** From an opening brace to the one that closes it, counting the pairs between. */
function block(css: string, opening: string): string {
  const start = css.indexOf(opening)
  if (start === -1) throw new Error(`web/styles.css has no ${opening} block for the site to share`)

  let depth = 0
  for (let index = start + opening.length - 1; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1
    else if (css[index] === '}') {
      depth -= 1
      if (depth === 0) return css.slice(start, index + 1)
    }
  }

  throw new Error(`web/styles.css leaves ${opening} unclosed`)
}

/**
 * The favicon: a C in the application's accent, with both colours taken from the tokens rather than
 * chosen again here. It has one palette and not two, because a browser tab is drawn from a cached
 * image and knows nothing about the reader's theme, so it takes the light pair.
 */
function icon(application: string): string {
  const token = (name: string) =>
    new RegExp(`--${name}:\\s*([^;]+);`).exec(application)?.[1]?.trim()
  const [accent, ink] = [token('accent'), token('accent-ink')]
  if (accent === undefined || ink === undefined) {
    throw new Error('web/styles.css declares no accent pair for the icon')
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="7" fill="${accent}" />
  <path d="M22 21.5a9 9 0 1 1 0-11" fill="none" stroke="${ink}" stroke-width="3.5" stroke-linecap="round" />
</svg>
`
}

/**
 * What a page may link out over, and nothing else. `javascript:` and `data:` are the two that make a
 * link into code, and a documentation site has no use for either.
 *
 * `marked` does not sanitise, and this is deliberately not a sanitiser: the Markdown rendered here is
 * authored in this repository and reviewed as code, so an unsafe URL or a `<script>` in a document is
 * a mistake, and the build refusing to publish it is a better answer than quietly rewriting what
 * somebody wrote. Anyone who can commit a `javascript:` URL to `docs/` can commit to this file too.
 */
const schemes = ['http:', 'https:', 'mailto:']

/**
 * Every page and every link, checked against what was built. The build refuses rather than publishing
 * a page that sends a reader nowhere, because the one thing this site exists to do is get somebody
 * from the front page to a running Caroline.
 */
function verify(files: ReadonlyMap<string, string>): void {
  const identifiers = (contents: string) =>
    new Set([...contents.matchAll(/id="([^"]*)"/g)].map((match) => match[1]))

  for (const [path, contents] of files) {
    if (!path.endsWith('.html')) continue

    // Criterion 7, enforced where it matters rather than only asserted: a script that reached a page
    // through a document's raw HTML would otherwise be published and noticed by the suite afterwards.
    const scripting = /<(script|iframe)\b|<[a-z][^>]*\son[a-z]+\s*=/i.exec(contents)
    if (scripting !== null) {
      throw new Error(`${path} carries ${scripting[0]}, and a page of this site runs nothing`)
    }

    for (const match of contents.matchAll(/href="([^"]*)"/g)) {
      const href = (match[1] ?? '').replace(/&amp;/g, '&')
      if (isAbsolute(href)) {
        if (!schemes.some((scheme) => href.toLowerCase().startsWith(scheme))) {
          throw new Error(
            `${path} links to ${href}, over a scheme this site does not link out with`,
          )
        }
        continue
      }

      // Split at the first `#` only. The rest is the fragment, `#` and all: a browser asks for the
      // whole of it, so validating the part before a second `#` would pass a link that lands nowhere.
      const separator = href.indexOf('#')
      const target = separator === -1 ? href : href.slice(0, separator)
      const fragment = separator === -1 ? '' : href.slice(separator + 1)
      const page = target === '' ? path : posix.normalize(posix.join(posix.dirname(path), target))
      const rendered = files.get(page)
      if (rendered === undefined) {
        throw new Error(`${path} links to ${href}, which the build did not produce`)
      }
      if (fragment !== '' && !identifiers(rendered).has(fragment)) {
        throw new Error(`${path} links to ${href}, and ${page} has nothing called ${fragment}`)
      }
    }
  }
}

/** The site, as a map of path to contents. Nothing is written here: `site/main.ts` does that. */
export function buildSite(sources: SiteSources = repositorySources()): Map<string, string> {
  const entries = manifest(sources)
  const context: BuildContext = {
    sources,
    outputs: new Map(entries.map((entry) => [entry.source, entry.output])),
    repository: repositoryUrl(sources),
  }

  const files = new Map<string, string>()

  for (const entry of entries) {
    const markdown =
      entry.output === 'index.html'
        ? homePage(sources.read(entry.source), context)
        : sources.read(entry.source)
    files.set(entry.output, layout(entry, render(markdown, entry, context), markdown, context))
  }

  const application = sources.read('web/styles.css')
  files.set('styles.css', `${palette(application)}\n${sources.read('site/styles.css')}`)
  files.set('icon.svg', icon(application))

  verify(files)

  return files
}

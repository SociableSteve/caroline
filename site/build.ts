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
import { readFileSync, readdirSync } from 'node:fs'
import { join, posix } from 'node:path'
import { Marked, type Tokens } from 'marked'

/**
 * Where the repository's files come from. A parameter so the suite can build a broken tree, and the
 * whole of what the build reads: two calls, both of them at a path inside the repository, so the output
 * is a function of the tree and of nothing else about the machine.
 */
export interface SiteSources {
  read(repositoryPath: string): string
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

/**
 * The pages of a tree, which is what the suite asserts against. A function rather than a constant: as a
 * constant it read `docs/specs` when the module was imported, so importing it from anywhere but the
 * repository root threw before any caller could say where the tree was.
 */
export const sitePages = (sources: SiteSources = repositorySources()): readonly SitePage[] =>
  manifest(sources)

/**
 * The blocks of a document. Either line ending, because a Windows checkout with `core.autocrlf` set
 * separates paragraphs with `\r\n\r\n`, and splitting on `\n\n` there makes every file one block: the
 * home page loses the README's opening and every description becomes the whole document.
 */
const paragraphs = (markdown: string): string[] => markdown.split(/\r?\n\r?\n/)

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
  // Trimmed before the punctuation goes, which is the order github-slugger uses: `## What now ?` is
  // `#what-now-` there, because the space the `?` leaves behind becomes a hyphen. Trimming afterwards
  // would drop it and refuse a fragment GitHub is right about.
  return heading
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .replace(/\s/g, '-')
}

const escapeText = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escapeAttribute = (value: string): string => escapeText(value).replace(/"/g, '&quot;')

/**
 * Rendered inline HTML back to the text a reader sees. Headings are slugged from this rather than from
 * their Markdown, because GitHub slugs the rendered text: a heading written as `## See [the docs](x)`
 * is `#see-the-docs` there, and slugging the source would make it `see-the-docsx`. The entities come
 * back with the tags, or a heading containing an `&` would slug as `amp`.
 */
const readAsText = (html: string): string =>
  html
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
const isAbsolute = (href: string): boolean =>
  /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')

/**
 * The repository, from `package.json`, so the one place that already names it stays the only one. It
 * is where a link to a file the site does not publish goes, and where the footer sends a reader who
 * wants to correct a page.
 */
function repositoryUrl(sources: SiteSources): string {
  const url = String(JSON.parse(sources.read('package.json')).repository?.url ?? '')
  // The repository name may contain a dot. Only a trailing `.git` is a suffix, so it is anchored at
  // the end rather than excluded from the name, which truncated `caroline.dev` to `caroline`.
  const slugged = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url)?.[1]
  if (slugged === undefined) throw new Error('package.json names no GitHub repository to link to')

  return `https://github.com/${slugged}`
}

/**
 * The id the layout puts on `<main>`, for the skip link. A heading whose slug is this one is refused,
 * because the alternatives are both worse: numbering it `content-1` leaves a `#content` written against
 * GitHub matching the shell and scrolling the reader to the top of the page rather than to the section,
 * which is the guarantee criterion 3 makes, and letting it through puts the same id on the page twice.
 */
const contentIdentifier = 'content'

interface Rendered {
  readonly html: string
  /** The `h2`s, in order: the table of contents of a long document. */
  readonly sections: readonly { readonly id: string; readonly label: string }[]
}

function render(markdown: string, page: SitePage, context: BuildContext): Rendered {
  const identifiers = new Set<string>()
  const sections: { id: string; label: string }[] = []
  const marked = new Marked({ gfm: true })
  /**
   * Collected here and thrown after the parse rather than from inside a renderer: `marked` catches what
   * a renderer throws and re-throws it with "Please report this to https://github.com/markedjs/marked."
   * appended, and the expected failure of this build is a broken link in somebody's pull request. Being
   * told to file a bug against a Markdown library is a poor answer to a typo. Collecting also reports
   * every bad link in a document rather than the first.
   */
  const failures: string[] = []

  marked.use({
    renderer: {
      heading(token: Tokens.Heading) {
        const label = this.parser.parseInline(token.tokens)
        const heading = slug(readAsText(label))
        // A heading of punctuation alone slugs to nothing, which would be `id=""` and a contents entry
        // pointing at `#`: a fragment that lands at the top of the page, past the check that a fragment
        // names a heading, because there is no fragment left to check.
        if (heading === '') {
          failures.push(
            `${page.source} has a heading with no identifier: "${token.text}" is punctuation, and a fragment cannot name it`,
          )
        }
        if (heading === contentIdentifier) {
          failures.push(
            `${page.source} has a heading whose identifier is "${contentIdentifier}", which is the one the page shell uses for its skip link: rename the heading`,
          )
        }
        let id = heading
        // Two headings can say the same thing. GitHub numbers the repeats, and so does this.
        for (let repeat = 1; identifiers.has(id); repeat += 1) id = `${heading}-${repeat}`
        identifiers.add(id)
        if (token.depth === 2) sections.push({ id, label })

        return `<h${token.depth} id="${escapeAttribute(id)}">${label}</h${token.depth}>\n`
      },

      /**
       * The site publishes the documents and nothing beside them: spec 11 has screenshots as a
       * non-goal, and no asset is copied into the output. An image in a document would therefore
       * render as a request for a file that is not there, and neither `verify` nor a reader's first
       * visit would be a good moment to find that out. Refusing says what the work would be.
       */
      image(token: Tokens.Image) {
        failures.push(
          `${page.source} embeds ${token.href}, and the site copies no assets: publishing an image means teaching site/build.ts to carry one`,
        )

        return ''
      },

      link(token: Tokens.Link) {
        const href = resolve(token.href, page, context, failures)
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
    // Any opening tag, not the bare one this renderer produces: a raw-HTML table with attributes would
    // otherwise take the page sideways on a phone and collect a closing `</div>` it never opened.
    .replace(/<table\b[^>]*>/g, (tag) => `<div class="table-scroll">${tag}`)
    .replaceAll('</table>', '</table></div>')

  if (failures.length > 0) throw new Error(failures.join('\n'))

  return { html, sections }
}

/**
 * A link, from the file that holds it to the page that renders its target. Two answers: a page of the
 * site, or a defect.
 *
 * There is deliberately no third answer. This asked the filesystem whether an unpublished target
 * existed and linked it at the repository if it did, which made the build's verdict depend on the
 * machine it ran on: a path ignored by git resolved locally and 404'd on GitHub, and the same tree in
 * CI failed instead. No document links to a file rather than a document, so the fallback was answering
 * a question nobody asked, in a way that broke the one guarantee the build makes about itself. A
 * document that wants to point at a source file can write its URL.
 */
function resolve(href: string, page: SitePage, context: BuildContext, failures: string[]): string {
  // `[the guide]()` and `[the guide](#)` are typos that publish a link which reloads the page. A
  // fragment with something after the hash is a link within the page and resolves like any other.
  if (href === '' || href === '#') {
    failures.push(`${page.source} has a link with nothing to link to, written as "${href}"`)

    return href
  }
  if (isAbsolute(href) || href.startsWith('#')) return href

  const [path = '', ...rest] = href.split('#')
  const fragment = rest.length === 0 ? '' : `#${rest.join('#')}`
  if (path === '') return href

  const target = posix.normalize(posix.join(posix.dirname(page.source), path))
  const output = context.outputs.get(target)
  if (output !== undefined) {
    return `${posix.relative(posix.dirname(page.output), output)}${fragment}`
  }

  failures.push(
    `${page.source} links to ${href}, which is no page of this site: publish it, or write the URL of the file`,
  )

  // The href it was written with, so the rest of the page renders and every bad link in a document is
  // reported at once. Nothing is published: the failure is thrown before this page is laid out.
  return href
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
function homePage(page: SitePage, markdown: string, context: BuildContext): string {
  const lede = (paragraphs(context.sources.read('README.md'))[1] ?? '').trim()
  if (lede === '')
    throw new Error('the README has no opening paragraph for the home page to render')

  /**
   * Rendered as the README rather than spliced into this page as Markdown. A link in that paragraph is
   * written relative to `README.md`, and splicing it would have it resolved relative to
   * `site/pages/index.md`: the build would then refuse a link the README is right about, and name a file
   * that does not contain it, or worse resolve `[x](index.md)` against a directory it was never about.
   */
  const rendered = render(
    lede,
    { source: 'README.md', output: page.output, title: '' },
    context,
  ).html

  // Function replacements, because a `$&` or a `` $` `` in the README's prose would otherwise be a
  // substitution pattern rather than two characters of somebody's paragraph.
  return markdown
    .replace('{{lede}}', () => rendered)
    .replace('{{diagram}}', () => diagram)
    .replace('{{start}}', () => actions(context))
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
  // A paragraph, which is to say prose: not a heading, a table, a list, a quotation or a command. A
  // description built from a document's opening code fence is a line of shell in a search result.
  const prose = /^([#|>-]|\*|\d+\.|```| {4}|<)/
  const paragraph = paragraphs(markdown)
    .map((block) => block.trim())
    .find((block) => block !== '' && !prose.test(block))
  const sentence = (paragraph ?? '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // A description is plain text. Markup a document opens its first paragraph with would otherwise
    // arrive here as an escaped tag, which is neither a description nor anything a reader wants.
    .replace(/<[^>]*>/g, '')
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (sentence.length <= 160) return sentence

  // A whole sentence where the paragraph offers one within the length, and a whole word otherwise.
  // Cutting mid-word is how a description ends up reading as a truncated database column.
  const stop = sentence.slice(0, 161).lastIndexOf('. ')
  if (stop >= 60) return sentence.slice(0, stop + 1)

  // A paragraph whose first 158 characters hold no space has no word boundary to cut at, and
  // `lastIndexOf` returning -1 through `slice` would drop one character rather than truncate.
  const boundary = sentence.lastIndexOf(' ', 157)

  return `${sentence.slice(0, boundary === -1 ? 157 : boundary)}…`
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
        <p class="toc-label">On this page</p>
        <ol>
          ${rendered.sections
            .map(
              // The label is text and not the heading's rendered HTML: a heading carrying a link would
              // otherwise put an anchor inside this one, which a browser closes early, and half the
              // entry stops linking to the fragment while the rest leaves the page.
              (section) =>
                `<li><a href="#${escapeAttribute(section.id)}">${escapeText(readAsText(section.label))}</a></li>`,
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
    <main id="${contentIdentifier}" tabindex="-1" class="${page.output === 'index.html' ? 'home' : 'document'}${contents === '' ? '' : ' with-contents'}">
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
 * The stylesheet with its comments blanked out, character for character, so that every index into it is
 * still an index into the original. Prose about a rule is not a rule: `:root {` in a sentence would
 * otherwise be where the palette is read from, and the first `--accent:` in a comment would be the
 * colour of the favicon.
 */
const withoutComments = (css: string): string =>
  css.replace(/\/\*[\s\S]*?\*\//g, (comment) => ' '.repeat(comment.length))

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

/**
 * From an opening brace to the one that closes it, counting the pairs between. Read from the blanked copy
 * so that neither the opening nor a brace can be found inside a comment, and sliced from the original so
 * that the palette keeps the comments it is written with.
 */
function block(css: string, opening: string): string {
  const searchable = withoutComments(css)
  const start = searchable.indexOf(opening)
  if (start === -1) throw new Error(`web/styles.css has no ${opening} block for the site to share`)

  let depth = 0
  for (let index = start + opening.length - 1; index < searchable.length; index += 1) {
    if (searchable[index] === '{') depth += 1
    else if (searchable[index] === '}') {
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
  const searchable = withoutComments(application)
  const token = (name: string) => new RegExp(`--${name}:\\s*([^;]+);`).exec(searchable)?.[1]?.trim()
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
 *
 * `mailto:` is not on the list, and that is the second criterion agreeing with the eighth rather than
 * an omission: no page of this site may carry an address, so a link that is one is a leak with a
 * scheme in front of it. The issues are the way to reach anybody.
 */
const schemes = ['http:', 'https:']

/**
 * A tag, quotes and all. `[^>]*>` ends a tag at the first `>`, which a quoted attribute value is
 * allowed to contain: `<a title=">" href="javascript:alert(1)">` would end at the title and the href
 * would never be read, which is precisely the tag somebody would write to get one past this.
 */
const tagPattern = /<[a-z][a-z0-9]*(?:"[^"]*"|'[^']*'|[^>"'])*>/gi

/**
 * The attributes that name something to fetch or somewhere to go. `data` is here because `<object>` uses
 * it, and a check that reads only `href` and `src` publishes `data="javascript:…"` untouched.
 */
const references = new Set(['href', 'src', 'data', 'srcset', 'poster'])

/**
 * The attributes of one tag, read left to right, so that what a value says cannot be taken for the name
 * of another attribute. Looking for `href=` anywhere in a tag finds it inside
 * `<meta content="… href=x …">`, where it is a document's prose rather than a link, and refuses to
 * publish a page over a sentence somebody wrote.
 */
function attributesOf(tag: string): [string, string][] {
  const interior = tag.replace(/^<[a-z][a-z0-9]*/i, '').replace(/\/?>$/, '')
  const pattern = /([a-z][a-z0-9-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/gi

  return [...interior.matchAll(pattern)].map((match) => [
    (match[1] ?? '').toLowerCase(),
    match[2] ?? match[3] ?? match[4] ?? '',
  ])
}

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
    // An `<img>` is here for the reason the renderer refuses a Markdown one, nothing being copied into
    // the output; `<style>` because the site has one stylesheet and an inline one can `@import` from
    // anywhere; `<object>` and `<embed>` because they are an `<iframe>` by another name.
    // Comments out first: a tag parked inside one is not a tag the page carries, and refusing to publish
    // a page over `<!-- <img src="x"> -->` would be a build failing on something a browser never reads.
    const published = contents.replace(/<!--[\s\S]*?-->/g, '')
    const forbidden = /<(script|iframe|img|object|embed|style)\b/i.exec(published)
    if (forbidden !== null) {
      throw new Error(`${path} carries ${forbidden[0]}, which a page of this site does not`)
    }

    // The tags, and the attributes inside them. Every form of an attribute, not the one this generator
    // writes, because a raw `<a HREF='javascript:…'>` in a document reaches the page untouched. Reading
    // the page rather than its tags would read escaped prose too, and a document that shows an anchor
    // in a code sample would fail the build on a link nobody wrote.
    for (const match of published.matchAll(tagPattern)) {
      const element = (/^<([a-z][a-z0-9]*)/i.exec(match[0])?.[1] ?? '').toLowerCase()

      for (const [name, value] of attributesOf(match[0])) {
        if (name.startsWith('on')) {
          throw new Error(`${path} sets ${name}, and a page of this site runs nothing`)
        }
        if (!references.has(name)) continue
        const href = value.replace(/&amp;/g, '&')
        // The raw-HTML spelling of the same typo: a reference to nothing, which reloads the page.
        if (href === '' || href === '#') {
          throw new Error(`${path} has a <${element}> with nothing to link to`)
        }

        if (isAbsolute(href)) {
          if (!schemes.some((scheme) => href.toLowerCase().startsWith(scheme))) {
            throw new Error(
              `${path} links to ${href}, over a scheme this site does not link out with`,
            )
          }
          // An anchor is a reader choosing to go somewhere. Anything else is the page fetching from
          // another host as it loads, which is the whole of what criterion 7 says it does not do: a
          // stylesheet, a font or an image from a CDN is also a record of who read the page.
          if (element !== 'a') {
            throw new Error(
              `${path} fetches ${href} in a <${element}>, and a page of this site fetches nothing from another host`,
            )
          }
          continue
        }

        // Root-relative, which normalises into something that resolves here and points at another site
        // once this one is served under a path. Criterion 5, and the one form of it that looked fine.
        if (href.startsWith('/')) {
          throw new Error(`${path} links to ${href}, which is root-relative rather than relative`)
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
        ? homePage(entry, sources.read(entry.source), context)
        : sources.read(entry.source)
    files.set(entry.output, layout(entry, render(markdown, entry, context), markdown, context))
  }

  const application = sources.read('web/styles.css')
  files.set('styles.css', `${palette(application)}\n${sources.read('site/styles.css')}`)
  files.set('icon.svg', icon(application))

  verify(files)

  return files
}

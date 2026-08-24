/**
 * The rules all five surfaces share. Spec 10, criteria 4, 5, 6, 9, 14, 17 to 21, and 23.
 *
 * The scales themselves are asserted against the stylesheet in `styles.test.ts`. What is here is
 * everything that only shows up once a surface is rendered: the heading outline, the title, the
 * single implementation of each primitive, and the states that must be carried by words as well as
 * by colour.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { declarations } from '../test/helpers/css.js'
import { Board } from './surfaces/Board.js'
import { Dashboard } from './surfaces/Dashboard.js'
import { Jobs } from './surfaces/Jobs.js'
import { ProjectDetail, Projects } from './surfaces/Projects.js'
import { Settings } from './surfaces/Settings.js'
import { aProject, aProposal, aReviewTask, aTask, NOW } from './test-fixtures.js'
import { surfaceTitle } from './title.js'

const boardHandlers = {
  onStatusChange: vi.fn(),
  onBlockerChange: vi.fn(),
  onComplete: vi.fn(),
  onDelete: vi.fn(),
  onDatesChange: vi.fn(),
  onMarkReviewed: vi.fn(),
  onAcceptProposal: vi.fn(),
  onDismissProposal: vi.fn(),
  onUndoStatus: vi.fn(),
  onSelect: vi.fn(),
  selected: null,
}

/** Every surface, at its emptiest, which is the state a clean checkout is in. */
const surfaces: ReadonlyArray<{ name: string; title: string; render: () => void }> = [
  {
    name: 'Dashboard',
    title: 'Today',
    render: () =>
      void render(
        <Dashboard
          tasks={[]}
          projects={[]}
          plan={null}
          calendar={null}
          staleDays={7}
          now={NOW}
          onRegeneratePlan={vi.fn()}
          onComplete={vi.fn()}
          onSelect={vi.fn()}
          selected={null}
          hash="#/"
        />,
      ),
  },
  {
    name: 'Board',
    title: 'Board',
    render: () =>
      void render(
        <Board
          tasks={[]}
          projects={[]}
          staleDays={7}
          timezone="UTC"
          configLoaded={true}
          now={NOW}
          {...boardHandlers}
        />,
      ),
  },
  {
    name: 'Projects',
    title: 'Projects',
    render: () =>
      void render(
        <Projects
          projects={[]}
          selected={null}
          hash="#/projects"
          onSelect={vi.fn()}
          onCreate={vi.fn(async () => true)}
          onStateChange={vi.fn()}
          onDelete={vi.fn()}
        />,
      ),
  },
  {
    name: 'Project drill-in',
    title: 'Ship the thing',
    render: () =>
      void render(
        <ProjectDetail
          project={aProject({ id: 'project-1', title: 'Ship the thing' })}
          tasks={[]}
          staleDays={7}
          timezone="UTC"
          configLoaded={true}
          now={NOW}
          onStatusChange={vi.fn()}
          onComplete={vi.fn()}
          onDelete={vi.fn()}
          onDatesChange={vi.fn()}
          onSelect={vi.fn()}
          selected={null}
          hash="#/projects/project-1"
        />,
      ),
  },
  {
    name: 'Jobs',
    title: 'Jobs',
    render: () => void render(<Jobs jobs={[]} runs={[]} spend={null} now={NOW} onRun={vi.fn()} />),
  },
  {
    name: 'Settings',
    title: 'Settings',
    render: () =>
      void render(
        <Settings
          google={null}
          health={null}
          preview={null}
          userName=""
          googleOutcome={null}
          onConnectGoogle={vi.fn()}
          onDisconnectGoogle={vi.fn()}
          onRefreshPreview={vi.fn()}
          onSaveUserName={vi.fn(async () => true)}
          mcpClients={null}
          onRevokeMcpClient={vi.fn()}
          mcpConsent={undefined}
          onDecideMcpConsent={vi.fn()}
        />,
      ),
  },
]

/**
 * Every source the client ships, found by walking `web/` rather than by naming two directories in
 * it. Criteria 17 to 21 and 23 are stated over the client and over "every utility in `web/`", and a
 * sweep that reads only `web/surfaces` and `web/components` reads neither `web/main.tsx` nor any
 * root-level source added after it, so the criteria would be asserted over part of the client while
 * claiming all of it. Test support is excluded by name, because a fixture is not something the
 * client draws.
 *
 * `web/index.html` is in the walk for the same reason `web/main.tsx` is. It is not a TypeScript
 * source, but it is a place the client writes utility classes: the mount point carries
 * `class="flex h-screen flex-col overflow-y-auto"` today, and a filter on `.tsx?` left every one of
 * these criteria stated over "the client" while a file the client ships was outside all of them.
 * What differs about it is the attribute name, `class` rather than `className`, and criterion 4's
 * sweep reads the quoted string rather than the attribute, so it needs nothing for that. What it
 * does need is a comment syntax of its own, which `stripComments` below dispatches on.
 */
const clientSources = readdirSync(join(process.cwd(), 'web'), {
  recursive: true,
  encoding: 'utf8',
})
  .map((entry) => `web/${entry}`)
  .filter(
    (file) =>
      /\.(?:tsx?|html)$/.test(file) && !/(?:^|\/)(?:test-[^/]*|[^/]*\.test)\.tsx?$/.test(file),
  )

/**
 * Comments out, code kept, by a scanner rather than by a pair of regexes. Two regexes could not do
 * it: `//` opens a line comment only where it is not inside a string, and a pattern that decides
 * that from the character before it reads a protocol-relative `"//cdn.example"` as the start of a
 * comment and blanks the rest of the line, which is the quietest way for a sweep below to stop
 * seeing what it is supposed to catch. Guarding `https://` and stopping was half the fix, because
 * the other half is a line-initial `//` and a URL with no scheme in front of it.
 *
 * So the scan tracks whether it is inside a quoted string, and only outside one does `//` or `/*`
 * open a comment. It is not a parser, and it has two ways of being wrong, which are not the same
 * size as each other:
 *
 * - An apostrophe in JSX text opens a string that never closes, so the rest of the file reads as
 *   quoted and a real comment after it is copied through rather than dropped. That direction strips
 *   less than it should, and the failure mode is a sweep reporting a commented-out utility: loud,
 *   and wrong in the direction that cannot hide anything.
 * - A `/`-delimited regex literal containing a quote character inverts the parity for the rest of
 *   the file. A real string's opening quote then reads as a closing one, the code between strings
 *   reads as quoted, and a `//` inside the next string opens a comment and blanks the line. That
 *   direction strips more than it should and the sweeps below go blind, which is the failure this
 *   suite exists to prevent rather than one it can afford.
 *
 * The second is guarded rather than reasoned away: `no regex literal in the client carries a quote`
 * below fails on one, so the scanner is never asked to survive the case it cannot. Nothing in the
 * client needs such a literal, and the nine it does write carry none.
 */
const withoutComments = (source: string): string => {
  let kept = ''
  let index = 0
  let delimiter: string | null = null

  while (index < source.length) {
    const character = source[index] as string

    if (delimiter !== null) {
      if (character === '\\') {
        kept += source.slice(index, index + 2)
        index += 2
        continue
      }
      if (character === delimiter) {
        delimiter = null
      }
      kept += character
      index += 1
      continue
    }

    if (character === "'" || character === '"' || character === '`') {
      delimiter = character
      kept += character
      index += 1
      continue
    }

    if (character === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') {
        index += 1
      }
      kept += ' '
      continue
    }

    if (character === '/' && source[index + 1] === '*') {
      const closes = source.indexOf('*/', index + 2)
      index = closes < 0 ? source.length : closes + 2
      kept += ' '
      continue
    }

    kept += character
    index += 1
  }

  return kept
}

/**
 * The comment syntax of whichever language the file is in. `web/index.html` comments with
 * `<!-- -->`, where the scanner above would read its markup as code, so a commented-out
 * `<!-- <div class="bg-red-500"> -->` in the shell has to come out by the rule the shell is written
 * under rather than by JavaScript's.
 */
const stripComments = (file: string, source: string): string =>
  file.endsWith('.html') ? source.replaceAll(/<!--[\s\S]*?-->/g, ' ') : withoutComments(source)

/** Every client source, comments out, which is what all six source sweeps below read. */
const client = clientSources.map((file) => ({
  file,
  source: stripComments(file, readFileSync(join(process.cwd(), file), 'utf8')),
}))

/**
 * The scanner above is safe against an apostrophe in JSX text and unsafe against a regex literal
 * carrying a quote, and this is what keeps the unsafe case out of the client rather than a claim in
 * a comment that it cannot happen. A literal such as `/'/` inverts the scanner's string parity for
 * the rest of the file, after which a `//` inside a real string blanks a line and every sweep below
 * silently stops seeing what is on it.
 *
 * Finding a regex literal without parsing is its own heuristic, so the delimiters it will start
 * from are deliberately few: `=`, `(`, `,`, `:`, `[`, `!`, `&`, `|`, `?`, `;` and `return`. `<` and
 * `>` are not among them, because `</div>` would read as a literal opening at the `<`, and neither
 * are `{` and `}`, because `{a} / {b}` in JSX would. Division survives because `= a / b` puts an
 * operand between the delimiter and the slash. The direction of any remaining error is a false
 * positive, which fails this test and is read, rather than a false negative, which would let the
 * case through.
 */
describe('the source scanner is never asked to guess', () => {
  const literal =
    /(?:^|[=(,:[!&|?;]|\breturn\b)\s*(\/(?![/*])(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\n\\[])+\/[dgimsuvy]*)/g

  const literals = client
    .filter(({ file }) => !file.endsWith('.html'))
    .flatMap(({ file, source }) =>
      [...source.matchAll(literal)].map((match) => ({ file, body: match[1] ?? '' })),
    )

  it('finds the regex literals the client writes, so the guard below is not vacuous', () => {
    expect(literals.length).toBeGreaterThan(5)
  })

  it('no regex literal in the client carries a quote', () => {
    expect(
      literals.filter(({ body }) => /['"`]/.test(body)).map(({ file, body }) => `${file}: ${body}`),
    ).toEqual([])
  })
})

describe('one heading outline per surface', () => {
  // Criterion 5. The client had exactly one `h1`, the word "Caroline" in the header, which left
  // every surface's outline headless.
  it.each(surfaces)('$name renders exactly one h1, and it names the surface', (surface) => {
    surface.render()

    const headings = screen.getAllByRole('heading', { level: 1 })
    expect(headings).toHaveLength(1)
    expect(headings[0]).toHaveTextContent(surface.title)
  })

  // Criterion 6. Five routes that all read "Caroline" are five indistinguishable history entries.
  it.each(surfaces)('$name names itself in the document title', (surface) => {
    document.title = 'unset'
    surface.render()

    expect(document.title).toBe(surfaceTitle(surface.title))
  })
})

/**
 * Criterion 4. Five primitives, one implementation each. The check is on the source rather than on
 * a render, because what went wrong before was a surface writing its own version of a pattern that
 * already existed: the label-and-value grid was built three times, and the pair of `--ink-quiet`
 * and a small font size ten times.
 */
describe('each primitive has one implementation', () => {
  const sources = client.filter(({ file }) => !file.endsWith('primitives.tsx'))

  it('finds the surfaces, so an empty sweep cannot pass as a clean one', () => {
    expect(sources.length).toBeGreaterThan(5)
  })

  /**
   * The class inside whichever quoted string it is written in, rather than only inside a
   * `className=` attribute. `className={cn('panel p-3', className)}` is the form `Panel` itself is
   * written in (`web/components/primitives.tsx`), so a sweep anchored on `className=` was blind to
   * the one form a caller has in front of it to copy. A quote opens the string and the pattern runs
   * to the end of the line, so a hit is a class string rather than a sentence, and comments come out
   * first so prose about the details panel is not a hit either.
   *
   * The line is the bound, which is what the criterion claims and no more. A class written into a
   * template literal wrapped over several lines sits past it, and widening the bound to the next
   * backtick is worse rather than better: a class of anything-but-a-backtick crosses whatever code
   * lies between two template literals, and `web/data.ts`, where `panel` is the name of a function,
   * is then reported as a surface writing its own `Panel`. Prettier keeps each argument of a `cn()`
   * call on its own line, so every class string in the client today is inside the bound.
   */
  it.each([
    { primitive: 'Facts', banned: /<dl[\s>]/, use: 'Facts and Fact' },
    { primitive: 'Field', banned: /<label[\s>]/, use: 'Field' },
    { primitive: 'Badge', banned: /['"`][^'"`\n]*\bbadge\b/, use: 'Badge' },
    { primitive: 'Panel', banned: /['"`][^'"`\n]*\bpanel\b/, use: 'Panel' },
  ])('no surface writes its own $primitive', ({ banned, use }) => {
    const offenders = sources
      .filter((entry) => banned.test(entry.source))
      .map((entry) => `${entry.file} should use ${use}`)

    expect(offenders).toEqual([])
  })
})

/**
 * The appearance model, checked against what the client actually spends. Every surface writes its
 * colours, weights and casing as Tailwind utility classes in JSX rather than as rules in
 * `web/styles.css`, so a sweep of the sources is the only place these can be asserted at all: there
 * is no stylesheet left to parse for them, and jsdom cannot tell a class applied from a class that
 * does something.
 *
 * Comments come out first, so prose about the `oklch(0.97)` that `--accent` is cannot fail a check
 * about an `oklch()` literal in a class string.
 */
describe('the appearance model, swept from the sources', () => {
  /**
   * Every Tailwind prefix that takes a colour, shared by the four sweeps that need to name them.
   * `text` and `border` take a length as well, which is what the arbitrary-value sweep allows for.
   * `ring-offset` is listed beside `ring` rather than left to it: `ring-offset-red-500` and
   * `ring-offset-[rebeccapurple]` are a colour chosen once for both palettes just as much as
   * `ring-red-500` is, and a list holding only `ring` reads `offset` where it wants a family name
   * and matches neither.
   */
  const colourPrefixes =
    'bg|text|border|ring-offset|ring|fill|stroke|from|via|to|divide|outline|decoration|shadow|caret|placeholder|accent'

  /**
   * The colour token names, derived from the `@theme inline` map rather than restated. A
   * hand-maintained third copy of the palette is a copy that goes out of date silently, and this
   * test already parses the sheet the map is in for criterion 23. `black` is added for the dialog
   * scrim, which is the one sanctioned non-token colour and so has no mapping to be derived from.
   */
  const sheet = declarations(readFileSync(join(process.cwd(), 'web/styles.css'), 'utf8'))
  const colourTokenNames = new Set([
    ...sheet
      .filter((rule) => rule.selector === '@theme inline' && rule.property.startsWith('--color-'))
      .map((rule) => rule.property.slice('--color-'.length)),
    'black',
  ])

  const offenders = (pattern: RegExp): string[] =>
    client.flatMap((entry) =>
      (entry.source.match(pattern) ?? []).map((hit) => `${entry.file}: ${hit}`),
    )

  it('finds the client, so an empty sweep cannot pass as a clean one', () => {
    expect(client.length).toBeGreaterThan(10)
  })

  it('derives the colour tokens from the sheet, so the sweeps naming them are not vacuous', () => {
    expect(colourTokenNames.size).toBeGreaterThan(20)
    expect(colourTokenNames).toContain('muted-foreground')
  })

  /**
   * Criterion 17: three weights and no others. A whitelist rather than a blocklist, because a
   * blocklist of Tailwind's own weight names says nothing about `font-[700]` or a weight name added
   * to a later Tailwind. `font-mono` and `font-sans` share the prefix and are families rather than
   * weights, so they are in the allowed set too, and the match is anchored to a class boundary so
   * the arbitrary property `[font-variant-numeric:tabular-nums]` is not read as a `font-` utility.
   *
   * A variant prefix is matched and then ignored, the way criterion 20 matches one and then reads
   * it: `md:font-bold` is a weight the client sets, and a sweep anchored straight onto `font-` sees
   * the bare violation and not the prefixed one. `:` is inside the prefix class so a chain
   * (`md:hover:font-bold`) is caught whole rather than only from its last link, and the class still
   * cannot swallow `[font-variant-numeric:tabular-nums]`, because what follows that colon is
   * `tabular-nums` rather than a second `font-`. The navigation's `aria-[current=page]:font-medium`
   * is the occurrence in the client today, and it counts as a use of `font-medium`.
   */
  it('sets weight in font-normal, font-medium and font-semibold only', () => {
    const allowed = new Set(['normal', 'medium', 'semibold', 'mono', 'sans'])
    const used = client.flatMap((entry) =>
      [
        ...entry.source.matchAll(/(?:^|[\s'"`])(?:[A-Za-z0-9_[\]=.:-]*:)?font-([a-z0-9[\].-]+)/g),
      ].map((match) => ({ hit: `${entry.file}: ${match[0].trim()}`, weight: match[1] ?? '' })),
    )

    expect(used).not.toEqual([])
    expect(used.filter(({ weight }) => !allowed.has(weight)).map(({ hit }) => hit)).toEqual([])
    // And no weight set without spelling a `font-` utility at all. An arbitrary property
    // (`[font-weight:800]`) and an inline style (`style={{ fontWeight: 800 }}`) each set the
    // declaration directly, so the whitelist above never sees them: it reads the `font-` prefix and
    // there is none to read. The client writes neither, and the criterion is that it writes neither.
    expect(offenders(/\[font-weight:[^\]]*\]|font-weight\s*:|fontWeight/g)).toEqual([])
  })

  /**
   * Criterion 18. Uppercase without tracking is unreadable, and uppercase at a size a reader
   * navigates by costs the word its shape, so each occurrence has to carry both.
   */
  it('uppercases only small, tracked labels', () => {
    const small = /\btext-(?:xs|\[(?:9|10|11|12)px\])/
    // The class string each `uppercase` sits in, bounded by whichever quote opened it: a JSX
    // attribute, a `cn()` argument and a template literal all delimit differently, and a regex
    // fixed on one quote reads across the other two.
    // The delimiter is whichever quote opened last, and the string ends at the next occurrence of
    // that same character: matching the delimiter rather than any quote is what keeps an apostrophe
    // nested inside a template literal from being read as the opening quote of the class string. It
    // is still a heuristic and not a parser: a quote in a comment would have been stripped already,
    // but a quote inside a nested expression could still mislead it. Where nothing closes the
    // string, the line is the bound, so a missing quote narrows the window rather than widening it
    // to the whole file, which is what `Math.min` over an empty list used to do.
    const quoted = (source: string, at: number): string => {
      const before = source.slice(0, at)
      const opens = Math.max(
        before.lastIndexOf("'"),
        before.lastIndexOf('"'),
        before.lastIndexOf('`'),
      )
      const delimiter = opens < 0 ? '\n' : source[opens]
      const closes = source.indexOf(delimiter ?? '\n', at)
      const lineEnd = source.indexOf('\n', at)
      const end = closes < 0 ? (lineEnd < 0 ? source.length : lineEnd) : closes

      return source.slice(opens + 1, end)
    }

    const classStrings = client.flatMap((entry) =>
      [...entry.source.matchAll(/\buppercase\b/g)].map(
        (match) => `${entry.file}: ${quoted(entry.source, match.index)}`,
      ),
    )

    expect(classStrings).not.toEqual([])
    expect(classStrings.filter((hit) => !/\btracking-/.test(hit) || !small.test(hit))).toEqual([])
  })

  /**
   * Criterion 19: every colour comes from a token, so no rule can be right in one palette and wrong
   * in the other. The dialog scrim is the one sanctioned literal, and it is excluded by name rather
   * than by a pattern loose enough to let a second one through.
   */
  it('writes no colour literal, the dialog scrim excepted', () => {
    const literals = offenders(/#[0-9a-fA-F]{3,8}\b|\b(rgba?|hsla?|oklch|oklab|lab|lch)\(/g)

    expect(literals).toEqual([])
    expect(offenders(/\bbg-black\/\d+\b/g)).toEqual(['web/components/ui/dialog.tsx: bg-black/65'])
  })

  /**
   * Criterion 19's other half. A hex and an `oklch()` are not the only ways to write a colour that
   * is not a token: Tailwind ships its own palette, and `bg-red-500` or `text-white` would have
   * passed the sweep above while being exactly the thing the criterion forbids, a colour chosen once
   * for both palettes. The scrim is the one sanctioned use and it is excepted by its full name.
   */
  it('reaches for no colour from Tailwind’s own palette either', () => {
    const families =
      'red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone|white|black'
    const utilities = new RegExp(
      String.raw`\b(?:${colourPrefixes})-(?:${families})\b(?:-\d{2,3})?(?:\/(?:\d+|\[[\d.]+\]))?`,
      'g',
    )

    expect(offenders(utilities)).toEqual(['web/components/ui/dialog.tsx: bg-black/65'])
  })

  /**
   * Criterion 19's third form, and the one neither sweep above can see: an arbitrary value.
   * `bg-[rebeccapurple]` and `border-[green]` write no hex, no colour function and no Tailwind
   * family name, and they are exactly what the criterion forbids, a colour chosen once for both
   * palettes. Rather than list CSS's hundred and fifty colour names, the rule is what the value may
   * be: a length, so the four `text-[Npx]` rungs the client spends stay legal, or a `var(--token)`,
   * which is the criterion itself. Anything else on one of these prefixes is a colour.
   *
   * A CSS type hint in front of the token counts as the same thing: Tailwind's own escape hatch for
   * an ambiguous arbitrary value is `bg-[color:var(--card)]`, which names a token exactly as
   * `bg-[var(--card)]` does, and a check keyed on the value starting `var(--` reported it as a
   * colour literal. The hint is allowed and what follows it still has to be a token, so
   * `bg-[color:red]` fails on the value rather than passing on the hint.
   */
  it('writes no arbitrary value on a colour utility but a length or a token', () => {
    const arbitrary = client.flatMap((entry) =>
      [
        ...entry.source.matchAll(new RegExp(String.raw`\b(?:${colourPrefixes})-\[([^\]]*)\]`, 'g')),
      ].map((match) => ({ hit: `${entry.file}: ${match[0]}`, value: match[1] ?? '' })),
    )

    expect(arbitrary).not.toEqual([])
    expect(
      arbitrary
        .filter(({ value }) => !/^\.?\d/.test(value) && !/^(?:[a-z-]+:)?var\(--/.test(value))
        .map(({ hit }) => hit),
    ).toEqual([])
  })

  /**
   * Criterion 20. `--accent` is shadcn's near-neutral hover ground, not this design's accent: the
   * blue is the chart ramp. A resting `bg-accent` is invisible, and it is the mistake the token's
   * name invites.
   */
  it('uses accent only behind a state variant, and never at rest', () => {
    // A whitelist of the variants the criterion sanctions, checked against the prefix each
    // occurrence actually carries. The previous version skipped any match preceded by `:` or `]`,
    // which passed every variant rather than the sanctioned ones, so the criterion could not have
    // failed on a variant it did not name.
    // `:` is inside the prefix class, so a chain is captured whole rather than from its last link
    // only. Without it `md:hover:bg-accent` and `dark:hover:bg-accent` both read as the sanctioned
    // `hover:` and passed, which made the whitelist a check on the last variant instead of on the
    // variants the occurrence actually carries. A longer chain is therefore an unsanctioned prefix
    // and fails, which is the conservative direction.
    const sanctioned = new Set(['hover:', 'data-[highlighted]:', 'aria-[current=page]:'])
    const found = client.flatMap((entry) =>
      [
        ...entry.source.matchAll(
          new RegExp(
            String.raw`([A-Za-z0-9_[\]=.:-]*:)?\b(?:${colourPrefixes})-(?:sidebar-)?accent[a-z-]*`,
            'g',
          ),
        ),
      ].map((match) => ({ hit: `${entry.file}: ${match[0]}`, prefix: match[1] ?? '' })),
    )

    expect(found).not.toEqual([])
    expect(found.filter(({ prefix }) => !sanctioned.has(prefix)).map(({ hit }) => hit)).toEqual([])
    // And each sanctioned variant is in use, so the whitelist is a description of the client rather
    // than a list of permissions nothing exercises.
    for (const variant of sanctioned) {
      expect(found.map(({ prefix }) => prefix)).toContain(variant)
    }
  })

  /**
   * Criterion 21. A tint of a token is still that token in both palettes, so opacity is the right
   * tool for a ground or a hairline. A text colour whose ratio depends on an alpha nobody computed
   * is a contrast claim nobody can check, which is why the modifier never goes on text.
   */
  /**
   * Criterion 23. A `*-foreground` utility is the half of a pairing that carries the text, so a name
   * that resolves to nothing is a label drawn in whatever colour it inherited: no error, no fallback
   * worth the name, and no contrast claim that can be checked. That is what
   * `text-destructive-foreground` was, on `Button`'s destructive variant, while `@theme inline`
   * mapped `--color-destructive-foreground` at a token neither palette declared.
   *
   * Two halves, both whitelists: every mapping in `@theme inline` has to point at a token both
   * palettes declare, and every `*-foreground` utility the client writes has to name one of those
   * mappings. A hardcoded list of token names could not have caught the gap, because the gap was a
   * name missing from the list as well as from the sheet.
   */
  it('names a foreground only where the token behind it is declared', () => {
    // Both palettes separately rather than their union. `:root` is the selector of the dark block
    // and of the light one inside the media query, so a set built from the selector alone is
    // satisfied by a token declared in only one of them, which is this criterion's own failure mode
    // one palette narrower: the utility resolves to nothing wherever the name is missing.
    const declaredIn = (context: string): Set<string> =>
      new Set(
        sheet
          .filter((rule) => rule.selector === ':root' && rule.context === context)
          .map((rule) => rule.property),
      )
    const palettes = [
      { name: 'the dark palette', tokens: declaredIn('') },
      {
        name: 'the light palette',
        tokens: declaredIn('@media (prefers-color-scheme: light)'),
      },
    ]

    for (const { name, tokens } of palettes) {
      expect(
        tokens.size,
        `${name} declares nothing, so the sweep below is vacuous`,
      ).toBeGreaterThan(20)
    }

    const theme = new Map(
      sheet
        .filter((rule) => rule.selector === '@theme inline')
        .map((rule) => [rule.property, rule.value] as const),
    )

    expect(theme.size).toBeGreaterThan(20)

    const dangling = [...theme]
      .filter(([property]) => property.startsWith('--color-'))
      .flatMap(([property, value]) =>
        [...value.matchAll(/var\((--[a-z0-9-]+)\)/g)].flatMap((match) =>
          palettes
            .filter(({ tokens }) => !tokens.has(match[1] ?? ''))
            .map(({ name }) => `${property} points at ${match[1]}, which ${name} does not declare`),
        ),
      )

    expect(dangling).toEqual([])

    // Whatever prefix the utility carries, and not a list of three. `ring-`, `fill-`, `stroke-`,
    // `divide-`, `outline-`, `placeholder-`, `caret-` and the gradient stops take a colour as much
    // as `bg-`, `text-` and `border-` do, and a sweep naming three of them could not fail on
    // `fill-nope-foreground`. So the prefix is any utility name, and what keeps the declarations
    // out is that in `var(--card-foreground)` and in a `--color-*` mapping the name is preceded by
    // a hyphen, where in a utility it is preceded by a quote, a space or a variant's colon.
    const utilities = client.flatMap((entry) =>
      [...entry.source.matchAll(/(?<![-\w])[a-z]+-((?:[a-z0-9]+-)*foreground)\b/g)].map(
        (match) => ({ hit: `${entry.file}: ${match[0]}`, token: match[1] ?? '' }),
      ),
    )

    expect(utilities).not.toEqual([])
    expect(
      utilities.filter(({ token }) => !theme.has(`--color-${token}`)).map(({ hit }) => hit),
    ).toEqual([])
  })

  it('derives fills and hairlines from opacity, and never text', () => {
    // Named tokens rather than `[a-z0-9-]+`, because `text-<x>/<n>` is two different utilities
    // depending on what `<x>` is: `text-sm/6` is Tailwind's font-size-with-line-height shorthand and
    // `text-muted-foreground/40` is an opacity on a colour. A blocklist over any word caught the
    // second and false-positived on the first, and missed `text-[11px]/40` (a line height on an
    // arbitrary size) entirely. Naming the colour tokens is what tells the two apart, and they come
    // from the sheet rather than from a list restated here.
    const tinted = (property: string): RegExp =>
      new RegExp(
        String.raw`\b${property}-(?:${[...colourTokenNames].join('|')})\/(?:\d+|\[[\d.]+\])`,
        'g',
      )

    expect(offenders(tinted('text'))).toEqual([])
    expect(offenders(tinted('bg')).concat(offenders(tinted('border')))).not.toEqual([])
  })

  /**
   * Criterion 21's other half, and the half the criterion used to state without checking. "Every
   * opacity modifier in the client names a token" was asserted only in the `text-` direction, so a
   * `bg-[#abc]/50` or a `border-white/30` satisfied every sweep here while being exactly what the
   * sentence forbids. This reads the modifier from the other end: whatever the utility tints has to
   * be a token the sheet declares, and the dialog scrim is excepted by its full name the way
   * criterion 2 excepts `--shadow-1`, so a second literal has to argue for itself.
   *
   * The font-size shorthand is skipped rather than allowed to fail. `text-sm/6` sets a line height
   * and tints nothing, so it is not an opacity modifier and the criterion says nothing about it. The
   * client writes none today; the exclusion is here so that writing one is not a spurious failure.
   */
  it('tints only tokens, the dialog scrim excepted', () => {
    const fontSizes = /^(?:xs|sm|base|lg|xl|\d+xl|\[[^\]]+\])$/
    const tints = client.flatMap((entry) =>
      [
        ...entry.source.matchAll(
          new RegExp(
            String.raw`\b(${colourPrefixes})-([A-Za-z0-9_.[\]-]+?)\/(?:\d+|\[[\d.]+\])`,
            'g',
          ),
        ),
      ].map((match) => ({
        hit: `${entry.file}: ${match[0]}`,
        prefix: match[1] ?? '',
        tinted: match[2] ?? '',
      })),
    )

    expect(tints).not.toEqual([])
    expect(
      tints
        .filter(({ prefix, tinted }) => !(prefix === 'text' && fontSizes.test(tinted)))
        .filter(({ tinted }) => !colourTokenNames.has(tinted))
        .map(({ hit }) => hit),
    ).toEqual([])
    // And `black` is in the token set for one utility only, so the exception stays the scrim rather
    // than becoming a licence.
    expect(tints.filter(({ tinted }) => tinted === 'black').map(({ hit }) => hit)).toEqual([
      'web/components/ui/dialog.tsx: bg-black/65',
    ])
  })
})

/**
 * One filled primary per context. Spec 10, criterion 14: `.primary` is a filled action, so
 * two of them in one row of controls is two obvious things to press, which is none.
 *
 * A row of controls is the context, and not the surface: a board of review cards has a primary on
 * each of them, and that is right, because a card is what is being acted on.
 */
describe('one filled primary per context', () => {
  const boardWithEverything = () =>
    render(
      <Board
        tasks={[aReviewTask(), aTask({ id: 'task-2', title: 'Captured', proposal: aProposal() })]}
        projects={[]}
        staleDays={7}
        timezone="UTC"
        configLoaded={true}
        now={NOW}
        {...boardHandlers}
      />,
    )

  it.each([
    { name: 'Board', render: boardWithEverything },
    ...surfaces.map((surface) => ({ name: surface.name, render: surface.render })),
  ])('$name puts at most one in any row of controls', ({ render: draw }) => {
    draw()

    const rows = Array.from(document.querySelectorAll('.action-row'))
    expect(rows.map((row) => row.querySelectorAll('.primary').length).filter((n) => n > 1)).toEqual(
      [],
    )
  })
})

/** Criterion 9: focus is visible on every interactive element, the card and its disclosure too. */
describe('focus', () => {
  const stylesheet = readFileSync(join(process.cwd(), 'web/styles.css'), 'utf8')

  it('is declared once, globally, rather than per control', () => {
    expect(stylesheet).toMatch(/:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--ring\)/)
    expect(stylesheet).toMatch(/:focus-visible\s*\{[^}]*outline-offset:\s*2px/)
  })

  it('is never removed by a rule that would undo it', () => {
    expect(stylesheet).not.toMatch(/outline:\s*(none|0)/)
  })
})

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
 */
const clientSources = readdirSync(join(process.cwd(), 'web'), {
  recursive: true,
  encoding: 'utf8',
})
  .map((entry) => `web/${entry}`)
  .filter((file) => /\.tsx?$/.test(file) && !/(?:^|\/)(?:test-[^/]*|[^/]*\.test)\.tsx?$/.test(file))

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
  const sources = clientSources
    .filter((file) => !file.endsWith('primitives.tsx'))
    .map((file) => ({
      file,
      source: readFileSync(join(process.cwd(), file), 'utf8'),
    }))

  it('finds the surfaces, so an empty sweep cannot pass as a clean one', () => {
    expect(sources.length).toBeGreaterThan(5)
  })

  // The class patterns are deliberately not tied to a quote style: `className={'panel'}` and a
  // template literal are the same bypass as `className="panel"`, and the point is that there is
  // no way to write the primitive by hand that the sweep does not see.
  it.each([
    { primitive: 'Facts', banned: /<dl[\s>]/, use: 'Facts and Fact' },
    { primitive: 'Field', banned: /<label[\s>]/, use: 'Field' },
    { primitive: 'Badge', banned: /className=[{\s]*['"`]badge/, use: 'Badge' },
    { primitive: 'Panel', banned: /className=[{\s]*['"`]panel/, use: 'Panel' },
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
  // `//` opens a line comment, except where it is the `//` of a URL: stripping from a `https://`
  // to the end of the line would blank the rest of that line for every sweep below, which is the
  // quietest way for a sweep to stop seeing what it is supposed to catch.
  const withoutComments = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')

  const client = clientSources.map((file) => ({
    file,
    source: withoutComments(readFileSync(join(process.cwd(), file), 'utf8')),
  }))

  const offenders = (pattern: RegExp): string[] =>
    client.flatMap((entry) =>
      (entry.source.match(pattern) ?? []).map((hit) => `${entry.file}: ${hit}`),
    )

  it('finds the client, so an empty sweep cannot pass as a clean one', () => {
    expect(client.length).toBeGreaterThan(10)
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
      String.raw`\b(?:bg|text|border|ring|fill|stroke|from|via|to|divide|outline|decoration|shadow)-(?:${families})\b(?:-\d{2,3})?(?:\/(?:\d+|\[[\d.]+\]))?`,
      'g',
    )

    expect(offenders(utilities)).toEqual(['web/components/ui/dialog.tsx: bg-black/65'])
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
    const sanctioned = new Set(['hover:', 'data-[highlighted]:', 'aria-[current=page]:'])
    const found = client.flatMap((entry) =>
      [
        ...entry.source.matchAll(
          /([A-Za-z0-9_[\]=.-]*:)?\b(?:bg|text|border)-(?:sidebar-)?accent[a-z-]*/g,
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
    const sheet = declarations(readFileSync(join(process.cwd(), 'web/styles.css'), 'utf8'))
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

    const utilities = client.flatMap((entry) =>
      [...entry.source.matchAll(/\b(?:bg|text|border)-([a-z0-9-]*foreground)\b/g)].map(
        (match) => `${entry.file}: ${match[0]}`,
      ),
    )

    expect(utilities).not.toEqual([])
    expect(
      utilities.filter((hit) => {
        const token = /-([a-z0-9-]*foreground)$/.exec(hit)?.[1] ?? ''
        return !theme.has(`--color-${token}`)
      }),
    ).toEqual([])
  })

  it('derives fills and hairlines from opacity, and never text', () => {
    // Named tokens rather than `[a-z0-9-]+`, because `text-<x>/<n>` is two different utilities
    // depending on what `<x>` is: `text-sm/6` is Tailwind's font-size-with-line-height shorthand and
    // `text-muted-foreground/40` is an opacity on a colour. A blocklist over any word caught the
    // second and false-positived on the first, and missed `text-[11px]/40` (a line height on an
    // arbitrary size) entirely. Listing the colour tokens is what tells the two apart.
    const colourTokens =
      'background|foreground|card|card-foreground|popover|popover-foreground|primary|primary-foreground|secondary|secondary-foreground|muted|muted-foreground|accent|accent-foreground|destructive|destructive-foreground|border|input|ring|chart-[1-5]|sidebar|sidebar-foreground|sidebar-accent|sidebar-accent-foreground|sidebar-border|white|black'
    const tinted = (property: string): RegExp =>
      new RegExp(String.raw`\b${property}-(?:${colourTokens})\/(?:\d+|\[[\d.]+\])`, 'g')

    expect(offenders(tinted('text'))).toEqual([])
    expect(offenders(tinted('bg')).concat(offenders(tinted('border')))).not.toEqual([])
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

/**
 * The rules all five surfaces share. Spec 10, criteria 4 to 9, 14, and 17 to 21.
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
  // Recursive, so a component filed in a subdirectory later is swept too rather than quietly
  // exempt: an enforcement test with a hole in it enforces nothing in the directory it misses.
  const componentFiles = ['web/surfaces', 'web/components']
    .flatMap((directory) =>
      readdirSync(join(process.cwd(), directory), { recursive: true, encoding: 'utf8' }).map(
        (file) => `${directory}/${file}`,
      ),
    )
    .filter(
      (file) =>
        file.endsWith('.tsx') && !file.endsWith('primitives.tsx') && !file.endsWith('.test.tsx'),
    )

  const sources = componentFiles.map((file) => ({
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
  const sourceFiles = ['web/surfaces', 'web/components']
    .flatMap((directory) =>
      readdirSync(join(process.cwd(), directory), { recursive: true, encoding: 'utf8' }).map(
        (file) => `${directory}/${file}`,
      ),
    )
    .concat('web/App.tsx')
    .filter((file) => file.endsWith('.tsx') && !file.endsWith('.test.tsx'))

  const withoutComments = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')

  const client = sourceFiles.map((file) => ({
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

  /** Criterion 17: three weights and no others. */
  it('sets weight in font-normal, font-medium and font-semibold only', () => {
    expect(offenders(/\bfont-(thin|extralight|light|bold|extrabold|black)\b/g)).toEqual([])
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
    const quoted = (source: string, at: number): string => {
      const before = source.slice(0, at)
      const after = source.slice(at)
      const opens = Math.max(
        before.lastIndexOf("'"),
        before.lastIndexOf('"'),
        before.lastIndexOf('`'),
      )
      const closes = [after.indexOf("'"), after.indexOf('"'), after.indexOf('`')].filter(
        (index) => index >= 0,
      )

      return source.slice(opens + 1, at + Math.min(...closes))
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
   * Criterion 20. `--accent` is shadcn's near-neutral hover ground, not this design's accent: the
   * blue is the chart ramp. A resting `bg-accent` is invisible, and it is the mistake the token's
   * name invites.
   */
  it('uses accent only behind a hover or highlighted variant', () => {
    const resting = client.flatMap((entry) =>
      (
        entry.source.match(/(?:^|[^:\]])\b(?:bg|text|border)-(?:sidebar-)?accent[a-z-]*/g) ?? []
      ).map((hit) => `${entry.file}: ${hit.trim()}`),
    )

    expect(resting).toEqual([])
    expect(
      offenders(/(?:hover|data-\[highlighted\]):(?:bg|text)-(?:sidebar-)?accent[a-z-]*/g),
    ).not.toEqual([])
  })

  /**
   * Criterion 21. A tint of a token is still that token in both palettes, so opacity is the right
   * tool for a ground or a hairline. A text colour whose ratio depends on an alpha nobody computed
   * is a contrast claim nobody can check, which is why the modifier never goes on text.
   */
  it('derives fills and hairlines from opacity, and never text', () => {
    expect(offenders(/\btext-[a-z0-9-]+\/(?:\d+|\[[\d.]+\])/g)).toEqual([])
    expect(offenders(/\b(?:bg|border)-[a-z0-9-]+\/(?:\d+|\[[\d.]+\])/g)).not.toEqual([])
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

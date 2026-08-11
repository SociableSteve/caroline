/**
 * The rules all six surfaces share. Spec 10, criteria 4 to 7 and 9.
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
import { Chat } from './surfaces/Chat.js'
import { Dashboard } from './surfaces/Dashboard.js'
import { Jobs } from './surfaces/Jobs.js'
import { ProjectDetail, Projects } from './surfaces/Projects.js'
import { Settings } from './surfaces/Settings.js'
import { aProject, NOW } from './test-fixtures.js'
import { surfaceTitle } from './title.js'

const boardHandlers = {
  onStatusChange: vi.fn(),
  onComplete: vi.fn(),
  onDelete: vi.fn(),
  onMarkReviewed: vi.fn(),
  onAcceptProposal: vi.fn(),
  onDismissProposal: vi.fn(),
  onUndoStatus: vi.fn(),
}

/** Every surface, at its emptiest, which is the state a clean checkout is in. */
const surfaces: ReadonlyArray<{ name: string; title: string; render: () => void }> = [
  {
    name: 'Dashboard',
    title: 'Dashboard',
    render: () =>
      void render(
        <Dashboard
          tasks={[]}
          projects={[]}
          health={null}
          jobRuns={[]}
          plan={null}
          history={[]}
          calendar={null}
          staleDays={7}
          now={NOW}
          onRegeneratePlan={vi.fn()}
          onComplete={vi.fn()}
        />,
      ),
  },
  {
    name: 'Board',
    title: 'Board',
    render: () =>
      void render(<Board tasks={[]} projects={[]} staleDays={7} now={NOW} {...boardHandlers} />),
  },
  {
    name: 'Projects',
    title: 'Projects',
    render: () =>
      void render(
        <Projects
          projects={[]}
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
          now={NOW}
          onStatusChange={vi.fn()}
          onComplete={vi.fn()}
          onDelete={vi.fn()}
        />,
      ),
  },
  {
    name: 'Chat',
    title: 'Chat',
    render: () =>
      void render(
        <Chat
          status={null}
          conversations={[]}
          conversation={null}
          messages={[]}
          draft={null}
          sending={false}
          failure={null}
          now={NOW}
          onSend={vi.fn()}
          onConfirm={vi.fn()}
          onUndo={vi.fn()}
        />,
      ),
  },
  {
    name: 'Jobs',
    title: 'Jobs',
    render: () => void render(<Jobs jobs={[]} runs={[]} now={NOW} onRun={vi.fn()} />),
  },
  {
    name: 'Settings',
    title: 'Settings',
    render: () =>
      void render(
        <Settings
          google={null}
          preview={null}
          googleOutcome={null}
          onConnectGoogle={vi.fn()}
          onDisconnectGoogle={vi.fn()}
          onRefreshPreview={vi.fn()}
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

  // Criterion 6. Six routes that all read "Caroline" are six indistinguishable history entries.
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

/** Criterion 9: focus is visible on every interactive element, the card and its disclosure too. */
describe('focus', () => {
  const stylesheet = readFileSync(join(process.cwd(), 'web/styles.css'), 'utf8')

  it('is declared once, globally, rather than per control', () => {
    expect(stylesheet).toMatch(/:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--accent\)/)
    expect(stylesheet).toMatch(/:focus-visible\s*\{[^}]*outline-offset:\s*2px/)
  })

  it('is never removed by a rule that would undo it', () => {
    expect(stylesheet).not.toMatch(/outline:\s*(none|0)/)
  })
})

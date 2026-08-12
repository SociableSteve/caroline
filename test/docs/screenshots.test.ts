/**
 * The pictures in the documentation: that they are generated rather than captured, that they are of
 * the seeded day rather than of anybody's own board, and that every one of them is used. Spec 11,
 * criterion 12.
 *
 * A screenshot is the one thing in this repository a test cannot read the contents of. So what is
 * asserted is everything around it: the file was produced by the script whose shot list names it, the
 * seed it is a picture of names no real person or repository, both palettes are there and both are
 * referenced, and nothing is committed that no document shows.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildSite, siteAssets } from '../../site/build.js'

const root = process.cwd()
const source = (path: string): string => readFileSync(join(root, path), 'utf8')

const images = readdirSync(join(root, 'docs/images')).sort()

/**
 * The documents that may carry a picture: every Markdown file under `docs`, at any depth, so the specs
 * are read too. Reading only the top level would have said an image was shown by nothing when a spec
 * was the only thing showing it, which is a failure about the wrong thing.
 */
const markdownUnder = (directory: string): string[] =>
  readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? markdownUnder(`${directory}/${entry.name}`)
      : entry.name.endsWith('.md')
        ? [source(`${directory}/${entry.name}`)]
        : [],
  )

const documents = markdownUnder('docs').join('\n')

const shoot = source('tools/demo/shoot.mjs')

describe('the screenshots are generated from the seeded day', () => {
  it('has both palettes of every shot the documentation script takes', () => {
    expect(images).toEqual([
      'board-dark.png',
      'board.png',
      'dashboard-dark.png',
      'dashboard.png',
      'rail-dark.png',
      'rail.png',
    ])
  })

  /**
   * The name is the link between a committed file and the script that produced it. A picture somebody
   * cropped by hand has no entry in that list, and this is the check that says so.
   */
  it('names every image in the shot list of tools/demo/shoot.mjs', () => {
    for (const image of images) {
      const shot = image.replace(/(-dark)?\.png$/, '')

      expect(shoot, image).toContain(`name: '${shot}'`)
    }
  })

  it('takes them in both palettes and writes the dark one under a suffix', () => {
    expect(shoot).toContain("['light', 'dark']")
    expect(shoot).toContain('prefers-color-scheme')
    expect(shoot).toContain('-dark')
  })

  it('is one command, and the same one a person would run', () => {
    const scripts = JSON.parse(source('package.json')).scripts as Record<string, string>

    expect(scripts['demo:shoot']).toContain('tools/demo/shoot.mjs')
    expect(source('tools/demo/README.md')).toContain('--docs')
  })

  /**
   * The seeded day is what the pictures show, and the site publishes them, so its contents are as
   * public as the prose. The fixtures were scrubbed of real names and repositories for this reason and
   * the seed is now read the same way: an owner that is not the reserved example one would put somebody
   * else's organisation on a page of this site.
   */
  it('seeds no repository outside the example owner, and no address', () => {
    const seed = source('tools/demo/seed.ts')

    // The three ways the seed names a repository: the field, the external id it builds from it, and
    // the URL a card links out to. A timezone is `Europe/London` and is not one of them, hence the
    // shapes rather than a bare slash.
    const owners = [
      ...seed.matchAll(/repository: '([\w-]+)\//g),
      ...seed.matchAll(/'([\w-]+)\/[\w.-]+#\d+/g),
      ...seed.matchAll(/github\.com\/([\w-]+)\//g),
    ].map(([, owner]) => owner)

    expect(owners.length).toBeGreaterThan(0)
    for (const owner of owners) expect(owner).toBe('example-org')
    expect(seed).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/)
    // The real owner of this repository, which is a real GitHub account and not a fixture.
    const repository = String(JSON.parse(source('package.json')).repository.url)
    const [, real = ''] = /github\.com[/:]([^/]+)\//.exec(repository) ?? []
    expect(real).not.toBe('')
    expect(seed).not.toContain(real)
  })

  it('keeps them small enough to clone: none of them over 500 kB', () => {
    for (const image of images) {
      expect(statSync(join(root, 'docs/images', image)).size, image).toBeLessThan(500_000)
    }
  })
})

describe('the site publishes the pictures the documentation uses, and no others', () => {
  const built = buildSite()
  const assets = siteAssets()

  it('copies every image, from docs/images and nowhere else', () => {
    expect(assets.map((asset) => asset.source)).toEqual(images.map((name) => `docs/images/${name}`))
    expect(assets.map((asset) => asset.output)).toEqual(images.map((name) => `images/${name}`))
  })

  /** A file nobody shows is a file nobody notices has gone stale. */
  it('shows every committed image in a document', () => {
    for (const image of images) {
      expect(documents, image).toContain(`images/${image}`)
    }
  })

  /**
   * The palette a document asks for, as the class the stylesheet acts on: GitHub reads the fragment,
   * and here it becomes the pair of rules that shows one image per theme.
   */
  it('renders each palette as the class the stylesheet hides under the other theme', () => {
    const usage = built.get('using.html') ?? ''

    expect(usage).toContain('<img class="shot light-only" src="images/board.png"')
    expect(usage).toContain('<img class="shot dark-only" src="images/board-dark.png"')
    expect(usage).not.toContain('gh-light-mode-only')

    const stylesheet = built.get('styles.css') ?? ''
    expect(stylesheet).toMatch(/\.shot\.dark-only\s*\{\s*display:\s*none/)
    expect(stylesheet).toMatch(/prefers-color-scheme: dark\)\s*\{[\s\S]*\.shot\.light-only/)
  })

  it('describes every picture, because half the readers of a page cannot see it', () => {
    for (const [path, contents] of built) {
      if (!path.endsWith('.html')) continue

      for (const tag of contents.match(/<img[^>]*>/g) ?? []) {
        expect(tag, path).toMatch(/alt="[^"]+"/)
      }
    }
  })
})

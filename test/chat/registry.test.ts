/**
 * Spec 07, criterion 2: no tool in the registry performs an outbound call to GitHub, Gmail or
 * Calendar. "The tool list is the enforcement", says the spec, so this test is about the list and
 * about what the list's code is allowed to import: an assertion over the source tree rather than
 * over one code path, in the same spirit as `test/llm/boundary.test.ts`.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { allChatTools, buildToolRegistry } from '../../src/chat/registry.js'
import { validateAgainstSchema } from '../../src/llm/validate.js'

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url))

function sourceFiles(directory: string): string[] {
  return readdirSync(join(repositoryRoot, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? sourceFiles(path) : /\.ts$/.test(entry.name) ? [path] : []
  })
}

/** Static and dynamic alike, so a late `await import` cannot slip past the check. */
function importsIn(path: string): string[] {
  const contents = readFileSync(join(repositoryRoot, path), 'utf8')
  return [...contents.matchAll(/(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g)].map(
    (match) => match[1] as string,
  )
}

describe('the chat tool registry', () => {
  /** Exactly the tools spec 07 lists, by the names it lists them under. */
  const expected = [
    'search_tasks',
    'get_task',
    'list_projects',
    'get_daily_plan',
    'get_capacity',
    'list_waiting',
    'list_reviews',
    'create_task',
    'update_task',
    'complete_task',
    'mark_reviewed',
    'delete_task',
    'create_project',
    'update_project',
    'regenerate_daily_plan',
  ]

  it('offers the tools spec 07 names, and no others', () => {
    expect(allChatTools.map((tool) => tool.name).toSorted()).toEqual(expected.toSorted())
  })

  it('gives every tool a description and a closed object schema', () => {
    for (const tool of allChatTools) {
      expect(tool.description.length, tool.name).toBeGreaterThan(20)
      expect(tool.parameters.type, tool.name).toBe('object')
      // Open schemas would let a model pass a field nothing validates and nothing reads.
      expect(tool.parameters.additionalProperties, tool.name).toBe(false)
    }
  })

  it('has schemas the validator can compile, since every call is checked against one', () => {
    for (const tool of allChatTools) {
      expect(() => validateAgainstSchema(tool.parameters, {}), tool.name).not.toThrow()
    }
  })

  /**
   * Criterion 2. The tools reach the repositories and the domain; a connector, an API client or a
   * `fetch` would be the hole the criterion is about, and it would be one import away.
   */
  it('never imports a connector, so no tool can reach an external system', () => {
    const offenders = sourceFiles(join('src', 'chat')).filter((path) =>
      importsIn(path).some(
        (specifier) => specifier.includes('/connectors/') || specifier.includes('connectors/'),
      ),
    )

    expect(offenders).toEqual([])
  })

  it('never mentions fetch, which is the other way out of the process', () => {
    const offenders = sourceFiles(join('src', 'chat')).filter((path) =>
      /\bfetch\s*\(/.test(readFileSync(join(repositoryRoot, path), 'utf8')),
    )

    expect(offenders).toEqual([])
  })

  it('finds the chat source tree, so an empty pass cannot read as a pass', () => {
    expect(sourceFiles(join('src', 'chat')).length).toBeGreaterThan(5)
  })

  /** Criterion 7, at the registry: without tool support there is nothing to offer. */
  it('offers nothing when the model cannot use tools', () => {
    expect(buildToolRegistry({ tools: false }).tools).toEqual([])
    expect(buildToolRegistry({ tools: false }).get('create_task')).toBeUndefined()
  })

  it('offers every tool by name when it can', () => {
    const registry = buildToolRegistry({ tools: true })

    expect(registry.tools).toHaveLength(expected.length)
    expect(registry.get('delete_task')?.alwaysConfirm).toBe(true)
  })

  /** Criterion 3 lives on this flag, so it is asserted rather than assumed to be set. */
  it('marks only delete_task as always needing confirmation', () => {
    const confirmable = allChatTools
      .filter((tool) => tool.alwaysConfirm === true)
      .map((tool) => tool.name)

    expect(confirmable).toEqual(['delete_task'])
  })

  it('splits the tools into the seven that read and the eight that write', () => {
    expect(allChatTools.filter((tool) => tool.kind === 'read')).toHaveLength(7)
    expect(allChatTools.filter((tool) => tool.kind === 'write')).toHaveLength(8)
  })

  /** Spec 12, criterion 12: required on a write tool, so a later one that omits it fails this. */
  it('declares idempotent on every write tool', () => {
    for (const tool of allChatTools.filter((tool) => tool.kind === 'write')) {
      expect(typeof tool.idempotent, tool.name).toBe('boolean')
    }
  })

  it('declares idempotent true only on complete_task and mark_reviewed (spec 12, criterion 12)', () => {
    const idempotent = allChatTools
      .filter((tool) => tool.idempotent === true)
      .map((tool) => tool.name)

    expect(idempotent.toSorted()).toEqual(['complete_task', 'mark_reviewed'])
  })

  /**
   * Spec 12: get_overview is offered to MCP alone, because chat is already sent what it
   * answers. It is still a `ChatTool`, executed through the same registry machinery, so this
   * asserts it by name rather than by import, which `test/mcp` covers from its own side.
   */
  it('does not offer get_overview to chat, which is already sent what it answers', () => {
    expect(allChatTools.map((tool) => tool.name)).not.toContain('get_overview')
  })
})

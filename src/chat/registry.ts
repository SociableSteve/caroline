/**
 * The tool registry: the whole of what chat can do. Spec 07 says it in as many words, and it is
 * worth restating here because it is the enforcement rather than a description of one.
 *
 * "There is no tool that reaches an external system. Chat cannot send email, comment on a PR or
 * create a calendar event, and the tool list is the enforcement." Every tool in this file's two
 * imports reads and writes Caroline's own database. `test/chat/registry.test.ts` asserts that from
 * the outside, by looking at what the tool modules import, so a connector reached for later cannot
 * arrive quietly.
 */
import type { ChatTool } from './types.js'
import { readTools } from './tools/read.js'
import { writeTools } from './tools/write.js'

/** Every tool there is, read and write. What the registry test inspects. */
export const allChatTools: readonly ChatTool[] = [...readTools, ...writeTools]

export interface ToolRegistry {
  /** What is offered to the model this turn. Empty when the model cannot use tools at all. */
  readonly tools: readonly ChatTool[]
  get(name: string): ChatTool | undefined
}

export interface RegistryOptions {
  /**
   * False when the configured model cannot be given tools (spec 03), which is spec 07 criterion
   * 7: no write tool is offered. Nothing else is offered either, because a model that cannot call
   * a tool cannot call a read tool: the turn answers from the context it was given and says so.
   */
  readonly tools: boolean
}

export function buildToolRegistry({ tools }: RegistryOptions): ToolRegistry {
  const offered = tools ? allChatTools : []
  const byName = new Map(offered.map((tool) => [tool.name, tool]))

  return {
    tools: offered,
    get: (name) => byName.get(name),
  }
}

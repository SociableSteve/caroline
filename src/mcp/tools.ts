/**
 * The MCP tool list: spec 07's registry, by reference, plus `get_overview` (spec 12). Not a copy
 * of the registry: `tools/list` answers with the same `ChatTool` objects `executeTool` validates
 * against, and the annotations are derived from each definition rather than written out per tool,
 * so a tool added to the registry appears here without this file being edited (criterion 11).
 */
import { allChatTools } from '../chat/registry.js'
import { getOverviewTool } from '../chat/tools/overview.js'
import type { ChatTool } from '../chat/types.js'
import type { JsonSchema } from '../llm/types.js'

export interface McpToolAnnotations {
  readonly readOnlyHint: boolean
  readonly destructiveHint: boolean
  readonly idempotentHint: boolean
}

export interface McpToolDescriptor {
  readonly name: string
  readonly description: string
  readonly inputSchema: JsonSchema
  readonly annotations: McpToolAnnotations
}

/**
 * `readOnlyHint` from `kind`, `destructiveHint` from `alwaysConfirm`, `idempotentHint` from the
 * idempotency field. Spec 12, criterion 12.
 *
 * `destructiveHint` is stated explicitly on every tool rather than left absent on the ones that
 * are not: the protocol's own default, when it is omitted, is true for a tool that is not
 * read-only, and saying nothing would advertise every write as destructive, `create_task`
 * included, and invite a confirmation prompt the tool never asks for.
 *
 * `idempotentHint` is true for a read tool, which is idempotent by construction, and is
 * `tool.idempotent` for a write tool, which spec 07 requires every one of them to declare.
 */
export function annotationsFor(tool: ChatTool): McpToolAnnotations {
  const readOnlyHint = tool.kind === 'read'

  return {
    readOnlyHint,
    destructiveHint: readOnlyHint ? false : tool.alwaysConfirm === true,
    idempotentHint: readOnlyHint ? true : tool.idempotent === true,
  }
}

function describe(tool: ChatTool): McpToolDescriptor {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters,
    annotations: annotationsFor(tool),
  }
}

/**
 * Every tool this surface offers: spec 07's registry unchanged (`list_reviews` included, because
 * this milestone adds it there) plus `get_overview`, which chat is not offered because chat is
 * already sent what it answers. Spec 12, criterion 11.
 */
export const mcpTools: readonly ChatTool[] = [...allChatTools, getOverviewTool]

export function mcpToolDescriptors(): readonly McpToolDescriptor[] {
  return mcpTools.map(describe)
}

export function findMcpTool(name: string): ChatTool | undefined {
  return mcpTools.find((tool) => tool.name === name)
}

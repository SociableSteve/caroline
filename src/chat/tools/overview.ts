/**
 * `get_overview`: the day's context, as a tool. Spec 12: chat is sent this unasked on every
 * message, and Caroline does not own an external client's system prompt, so an MCP client has
 * nowhere to be handed it except by calling something. This answers with the same object
 * `chatSystemPrompt` assembles, through the code that assembles it, so the two cannot drift.
 *
 * Deliberately not exported from `registry.ts`'s tool list: chat already has this, unasked, so
 * offering it there would be a second way to ask for what the prompt already carries. It is
 * still a `ChatTool` in the same shape every other one is, executed through the same
 * `executeTool`, so the content policy, the audit row and the derived annotations reach it
 * without an exception (spec 12, criterion 41).
 */
import { buildChatContext, contextPayload } from '../prompt.js'
import { defineTool } from '../types.js'

export const getOverviewTool = defineTool<Record<string, never>>({
  name: 'get_overview',
  kind: 'read',
  description:
    "The day's context: task counts by status, today's plan if one exists, remaining capacity, what is outstanding on other people, and how many projects are stalled. This is what chat is already given on every message; call it when you need the same picture.",
  parameters: { type: 'object', additionalProperties: false, properties: {} },
  execute(context) {
    const built = buildChatContext({
      database: context.database,
      config: context.config,
      now: context.now,
      calendarConnected: context.calendarConnected,
    })

    return { ok: true, data: contextPayload(built) }
  },
})

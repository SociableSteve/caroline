/**
 * What a chat tool is. The registry in `registry.ts` is the enforcement spec 07 relies on: the
 * model can do exactly what is on the list and nothing else, and nothing on the list reaches an
 * external system. `test/chat/registry.test.ts` asserts that rather than trusting it.
 */
import type { Config } from '../config/schema.js'
import type { Database } from '../db/connection.js'
import type { ChatChangeEntity, ChatInverse } from '../domain/chat.js'
import type { JsonSchema } from '../llm/types.js'

/** What came of asking for a plan to be redrawn. Chat does not draw it; the planner does. */
export type PlanRegeneration =
  | { readonly status: 'drawn'; readonly summary: string | null }
  | { readonly status: 'already-running' }
  /** The planner declined, and said why: no provider configured, or nothing to plan with. */
  | { readonly status: 'refused'; readonly detail: string }

/**
 * Everything a tool may touch. The database and the configuration, a fixed clock, and two
 * capabilities that belong to other parts of the process and are passed in rather than reached
 * for: whether a calendar can be read, and how a plan gets redrawn.
 */
export interface ChatToolContext {
  readonly database: Database
  readonly config: Config
  /** The turn's moment, fixed for its duration so everything it writes carries one time. */
  readonly now: number
  readonly calendarConnected: () => boolean
  readonly regeneratePlan: () => Promise<PlanRegeneration>
}

/**
 * One change a tool made, as it is recorded: what to tell the reader, what it was to, and what
 * it would take to put it back. `taskIds` is what the turn's bulk count is counted over, so a
 * tool that touches a task says which one rather than leaving the loop to infer it.
 */
export interface Mutation {
  readonly summary: string
  readonly entity: ChatChangeEntity
  readonly entityId: string | null
  /** Null where there is nothing to undo. Redrawing a plan is the case that is. */
  readonly inverse: readonly ChatInverse[] | null
  readonly taskIds: readonly string[]
}

/**
 * What a tool answers. A refusal is not an exception: it is a structured error the model is
 * given and may act on, which is what spec 07's "a malformed call returns a structured error to
 * the model" asks for. An exception, by contrast, is a bug and fails the turn.
 */
export type ToolOutcome =
  | { readonly ok: true; readonly data: unknown; readonly mutations?: readonly Mutation[] }
  | { readonly ok: false; readonly message: string }

export interface ChatTool {
  readonly name: string
  readonly description: string
  readonly parameters: JsonSchema
  /**
   * Read tools answer questions; write tools change things. The split is what makes chat
   * read-only when the model cannot use tools, and what the bulk threshold counts.
   */
  readonly kind: 'read' | 'write'
  /**
   * True for an operation that is never carried out on the model's word alone. Spec 07,
   * criterion 3: a delete waits for the user however confident the model is.
   */
  readonly alwaysConfirm?: boolean
  /**
   * Whether this tool changes tasks. Spec 07's threshold is a number of tasks, so a write that
   * touches none of them, such as creating a project or redrawing the plan, is not held by it.
   * Defaults to true, so a task-changing tool added later is counted rather than exempt by
   * omission.
   */
  readonly touchesTasks?: boolean
  /**
   * Whether calling this tool twice with the same arguments has the effect of calling it once.
   * Undefined on a read tool, which is idempotent by construction and has nothing to derive.
   * Required on every write tool (see the two `defineTool` overloads below), so that MCP's
   * `idempotentHint` (spec 12) is derived from a decision every write tool has made rather than
   * guessed at for one that has not. `complete_task` and `mark_reviewed` are the two tools that
   * declare it true: calling either again once it has applied changes nothing further.
   */
  readonly idempotent?: boolean
  /**
   * What a confirmation of this call should say, built from the arguments before anything has
   * been done. Only the confirmable tools need one.
   */
  describe?(context: ChatToolContext, args: unknown): string
  execute(context: ChatToolContext, args: unknown): ToolOutcome | Promise<ToolOutcome>
}

interface ToolDefinitionBase<Arguments> {
  readonly name: string
  readonly description: string
  readonly parameters: JsonSchema
  readonly touchesTasks?: boolean
  readonly describe?: (context: ChatToolContext, args: Arguments) => string
  readonly execute: (
    context: ChatToolContext,
    args: Arguments,
  ) => ToolOutcome | Promise<ToolOutcome>
}

/**
 * A tool declared with its argument type. The loop validates every call against `parameters`
 * before it gets here, so the cast is the one place that fact is used rather than restated in
 * fourteen tools.
 *
 * Two overloads rather than one, so that a write tool's `idempotent` is required at the type
 * level and not merely by convention: spec 12 asks that a write tool added without an
 * idempotency decision fail rather than be advertised on a default nobody chose, and an optional
 * field cannot enforce that. A read tool has no such field to omit.
 */
export function defineTool<Arguments>(
  definition: ToolDefinitionBase<Arguments> & {
    readonly kind: 'read'
    readonly alwaysConfirm?: false
  },
): ChatTool
export function defineTool<Arguments>(
  definition: ToolDefinitionBase<Arguments> & {
    readonly kind: 'write'
    readonly alwaysConfirm?: boolean
    readonly idempotent: boolean
  },
): ChatTool
export function defineTool<Arguments>(
  definition: ToolDefinitionBase<Arguments> & {
    readonly kind: 'read' | 'write'
    readonly alwaysConfirm?: boolean
    readonly idempotent?: boolean
  },
): ChatTool {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    kind: definition.kind,
    ...(definition.alwaysConfirm === undefined ? {} : { alwaysConfirm: definition.alwaysConfirm }),
    ...(definition.touchesTasks === undefined ? {} : { touchesTasks: definition.touchesTasks }),
    ...(definition.idempotent === undefined ? {} : { idempotent: definition.idempotent }),
    ...(definition.describe === undefined
      ? {}
      : {
          describe: (context: ChatToolContext, args: unknown) =>
            (definition.describe as (context: ChatToolContext, args: Arguments) => string)(
              context,
              args as Arguments,
            ),
        }),
    execute: (context, args) => definition.execute(context, args as Arguments),
  }
}

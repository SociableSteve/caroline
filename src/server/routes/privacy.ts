import type { FastifyInstance } from 'fastify'
import { resolveItemContext } from '../../chat/context.js'
import { llmLevelConsequences, storeLevelConsequences } from '../../config/content.js'
import type { Config } from '../../config/schema.js'
import type { Database } from '../../db/index.js'
import { listSourcesForTask } from '../../db/repositories/sources.js'
import { getUserName } from '../../db/repositories/settings.js'
import { getTask, listTasks } from '../../db/repositories/tasks.js'
import { bodyForSending, type ContentFetchers } from '../../jobs/classify.js'
import {
  buildClassificationPayload,
  CLASSIFICATION_PROMPT_VERSION,
} from '../../llm/prompts/classification.js'
import { renderPreamble } from '../../llm/prompts/preamble.js'
import { apiError } from '../errors.js'
import { privacyPreviewQuerySchema, privacyPreviewResponseSchema } from '../schemas.js'

export interface PrivacyRouteContext {
  readonly config: Config
  readonly database: Database
  /**
   * The same fetchers the classifier uses, so that at the default policy, where the body is sent
   * but never stored, the preview shows the snippet a real call would carry rather than the nothing
   * the database holds. Nothing fetched here is written anywhere.
   */
  readonly content?: ContentFetchers
  readonly now: () => number
}

/**
 * What a classification call would contain, for a real item, under the configuration as it stands.
 * Spec 09 criterion 9: the settings screen shows this before the policy is used, because a policy
 * nobody can see the effect of is a policy nobody can check.
 *
 * It is built by the same function the classifier calls, so what is previewed is what would be
 * sent, and not a second description of it that could drift.
 */
export function registerPrivacyRoutes(
  app: FastifyInstance,
  { config, database, content, now }: PrivacyRouteContext,
): void {
  app.get<{ Querystring: { taskId?: string } }>(
    '/api/privacy/preview',
    {
      schema: {
        querystring: privacyPreviewQuerySchema,
        response: { 200: privacyPreviewResponseSchema },
      },
    },
    async (request, reply) => {
      const { privacy } = config
      const policy = {
        llmContent: privacy.llmContent,
        storeContent: privacy.storeContent,
        snippetChars: privacy.snippetChars,
        llmConsequence: llmLevelConsequences[privacy.llmContent],
        storeConsequence: storeLevelConsequences[privacy.storeContent],
      }

      // The preamble every chat and planning call carries, rendered by the function those calls
      // render it with. It names the person using Caroline, which is personal data leaving the
      // machine on every call to a remote provider, so a preview without it no longer proves what
      // this screen claims to prove. Spec 09.
      const preamble = renderPreamble({ userName: getUserName(database) })

      const at = now()
      const task =
        request.query.taskId === undefined
          ? // The first inbox task in the task list's own order, so the preview is of real
            // correspondence rather than of an example nobody has. Close to what the classifier
            // would take next, and deliberately not the same query: this is an illustration, and
            // reusing the selection rule would tie the screen to it.
            (listTasks(database, { status: ['inbox'], limit: 1 }, at).tasks[0] ?? null)
          : getTask(database, request.query.taskId)

      if (task === null) {
        if (request.query.taskId !== undefined) {
          return reply.status(404).send(apiError('not_found', 'No such task'))
        }
        // Nothing captured yet. The policy is still worth answering with: it is what the screen is
        // mostly showing, and an empty payload is the honest preview of an empty inbox.
        return {
          policy,
          preamble,
          item: null,
          payload: null,
          itemContext: null,
          promptVersion: CLASSIFICATION_PROMPT_VERSION,
        }
      }

      const source = listSourcesForTask(database, task.id)[0] ?? null

      // The same resolution the classifier performs, including the transient fetch the default
      // policy requires. A provider that cannot be reached falls back to what is stored, because a
      // preview that fails is less use than one that is a line short.
      const body = await bodyForSending(source, config, content).catch(
        () => source?.content ?? null,
      )

      // What a turn would send about this same task if it were open in the rail, built by the function
      // a turn builds it with rather than by a second rendering that could drift from it. Spec 09.
      const itemContext = resolveItemContext({ database, config }, { kind: 'task', id: task.id })

      return {
        policy,
        preamble,
        item: { taskId: task.id, title: task.title, provider: source?.provider ?? null },
        itemContext,
        payload: buildClassificationPayload(
          {
            taskId: task.id,
            title: task.title,
            provider: source?.provider ?? null,
            metadata: source?.metadata ?? null,
            content: body,
            createdAt: task.createdAt,
          },
          privacy,
          at,
        ),
        promptVersion: CLASSIFICATION_PROMPT_VERSION,
      }
    },
  )
}

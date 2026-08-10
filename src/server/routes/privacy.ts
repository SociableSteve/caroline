import type { FastifyInstance } from 'fastify'
import { llmLevelConsequences, storeLevelConsequences } from '../../config/content.js'
import type { Config } from '../../config/schema.js'
import type { Database } from '../../db/index.js'
import { listSourcesForTask } from '../../db/repositories/sources.js'
import { getTask, listTasks } from '../../db/repositories/tasks.js'
import { bodyForSending, type ContentFetchers } from '../../jobs/classify.js'
import {
  buildClassificationPayload,
  CLASSIFICATION_PROMPT_VERSION,
} from '../../llm/prompts/classification.js'
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

      const at = now()
      const task =
        request.query.taskId === undefined
          ? // The item the classifier would take next, so the preview is of real correspondence
            // rather than of an example nobody has.
            (listTasks(database, { status: ['inbox'], limit: 1 }, at).tasks[0] ?? null)
          : getTask(database, request.query.taskId)

      if (task === null) {
        if (request.query.taskId !== undefined) {
          return reply.status(404).send(apiError('not_found', 'No such task'))
        }
        // Nothing captured yet. The policy is still worth answering with: it is what the screen is
        // mostly showing, and an empty payload is the honest preview of an empty inbox.
        return { policy, item: null, payload: null, promptVersion: CLASSIFICATION_PROMPT_VERSION }
      }

      const source = listSourcesForTask(database, task.id)[0] ?? null

      // The same resolution the classifier performs, including the transient fetch the default
      // policy requires. A provider that cannot be reached falls back to what is stored, because a
      // preview that fails is less use than one that is a line short.
      const body = await bodyForSending(source, config, content).catch(
        () => source?.content ?? null,
      )

      return {
        policy,
        item: { taskId: task.id, title: task.title, provider: source?.provider ?? null },
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

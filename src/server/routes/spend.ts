import type { FastifyInstance } from 'fastify'
import type { Config } from '../../config/schema.js'
import type { Database } from '../../db/index.js'
import { spendReport } from '../../llm/spend.js'
import { spendResponseSchema } from '../schemas.js'

export interface SpendRouteContext {
  readonly config: Config
  readonly database: Database
  readonly now: () => number
}

/**
 * What the models have cost this budget period, and where each provider stands against its
 * ceiling. Spec 03, criterion 15.
 *
 * Read-only and derived: nothing here writes, and the figures are rolled up from `llm_calls` at
 * the moment they are asked for rather than kept anywhere, so there is no second copy of the spend
 * to go stale.
 */
export function registerSpendRoutes(
  app: FastifyInstance,
  { config, database, now }: SpendRouteContext,
): void {
  app.get(
    '/api/spend',
    {
      schema: {
        querystring: { type: 'object', additionalProperties: false, properties: {} },
        response: { 200: spendResponseSchema },
      },
    },
    async () => spendReport({ config, database, now }),
  )
}

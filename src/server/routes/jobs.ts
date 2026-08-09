import type { FastifyInstance } from 'fastify'
import type { Database } from '../../db/index.js'
import { listJobRuns } from '../../db/repositories/job-runs.js'
import { SYNC_JOB, type SyncRunner } from '../../jobs/sync.js'
import { apiError } from '../errors.js'
import {
  jobListQuerySchema,
  jobListResponseSchema,
  jobNameParamsSchema,
  jobRunTriggeredResponseSchema,
} from '../schemas.js'

export interface JobRouteContext {
  readonly database: Database
  readonly sync: SyncRunner
}

/**
 * Run history and manual triggers. The scheduler arrives in M5 (spec 06); until then this
 * is how a sync happens on demand, and a manual run is first-class rather than a back door:
 * it takes the same path a scheduled one will.
 */
export function registerJobRoutes(app: FastifyInstance, { database, sync }: JobRouteContext): void {
  app.get<{ Querystring: { job?: string; limit: number } }>(
    '/api/jobs',
    {
      schema: {
        querystring: jobListQuerySchema,
        response: { 200: jobListResponseSchema },
      },
    },
    async (request) => {
      const { job, limit } = request.query
      return { runs: listJobRuns(database, { ...(job === undefined ? {} : { job }), limit }) }
    },
  )

  app.post<{ Params: { name: string } }>(
    '/api/jobs/:name/run',
    {
      schema: {
        params: jobNameParamsSchema,
        response: { 200: jobRunTriggeredResponseSchema },
      },
    },
    async (request, reply) => {
      const { name } = request.params
      if (name !== SYNC_JOB) {
        return reply.status(404).send(apiError('not_found', `No such job "${name}"`))
      }

      const outcome = await sync.run('manual')
      if (outcome.status === 'already-running') {
        // A clear answer rather than a second run. Spec 06, criterion 6.
        return reply
          .status(409)
          .send(apiError('already_running', 'A sync is already running. Wait for it to finish.'))
      }

      return { job: name, results: outcome.summary.results }
    },
  )
}

import type { FastifyInstance } from 'fastify'
import type { Database } from '../../db/index.js'
import { listJobRuns } from '../../db/repositories/job-runs.js'
import type { CarolineJobs } from '../../jobs/registry.js'
import { apiError } from '../errors.js'
import {
  jobListQuerySchema,
  jobListResponseSchema,
  jobNameParamsSchema,
  jobRunTriggeredResponseSchema,
  jobStatusResponseSchema,
} from '../schemas.js'

export interface JobRouteContext {
  readonly database: Database
  readonly jobs: CarolineJobs
}

/**
 * The run history, what is scheduled and when, and manual triggers. A manual run is first-class
 * rather than a back door: it takes the same path a scheduled one does, and is recorded with
 * `trigger: 'manual'`. Spec 06.
 */
export function registerJobRoutes(app: FastifyInstance, { database, jobs }: JobRouteContext): void {
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

  /**
   * What the jobs surface reads: one row per scheduled job with its last run, whether it is going
   * now, when it goes next, and whether failures are holding it back. Spec 06's "results are
   * discoverable in the UI".
   */
  app.get(
    '/api/jobs/status',
    {
      schema: {
        querystring: { type: 'object', additionalProperties: false, properties: {} },
        response: { 200: jobStatusResponseSchema },
      },
    },
    async () => ({ jobs: jobs.scheduler.status() }),
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
      const outcome = await jobs.scheduler.run(name, 'manual')

      if (outcome.status === 'unknown') {
        return reply.status(404).send(apiError('not_found', `No such job "${name}"`))
      }

      if (outcome.status === 'already-running') {
        // A clear answer rather than a second run. Spec 06, criterion 6.
        return reply
          .status(409)
          .send(
            apiError(
              'already_running',
              `The ${name} job is already running. Wait for it to finish.`,
            ),
          )
      }

      // Nothing is published here: the scheduler announces every run it records, whichever
      // trigger asked for it, so a second announcement would only make the open tabs reload twice.
      return { job: name, run: outcome.run }
    },
  )
}

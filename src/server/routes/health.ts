import type { FastifyInstance } from 'fastify'
import type { Config } from '../../config/schema.js'
import type { Database } from '../../db/index.js'
import { version } from '../version.js'

const integrationStatusSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['configured', 'status'],
  properties: {
    configured: { type: 'boolean' },
    status: { type: 'string', enum: ['configured', 'not configured', 'disabled'] },
  },
} as const

/**
 * Asked rather than assumed. Reaching this route means migrations ran at startup, but the
 * file can go away underneath a running process, and a health check that only reports what
 * was true at boot is not worth reading.
 */
function databaseStatus(database: Database): { status: 'ready' | 'unavailable' } {
  try {
    database.prepare('select 1').get()
    return { status: 'ready' }
  } catch {
    return { status: 'unavailable' }
  }
}

function describe(enabled: boolean, configured: boolean) {
  if (!enabled) return { configured: false, status: 'disabled' as const }
  return configured
    ? { configured: true, status: 'configured' as const }
    : { configured: false, status: 'not configured' as const }
}

/**
 * Process and integration status. An unconfigured integration is reported as such rather
 * than treated as a failure: a clean checkout with no credentials is a valid state.
 * Overview criterion 1.
 */
export function registerHealthRoute(
  app: FastifyInstance,
  config: Config,
  database: Database,
): void {
  app.get(
    '/api/health',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { verbose: { type: 'boolean' } },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['status', 'version', 'uptimeSeconds', 'integrations'],
            properties: {
              status: { type: 'string', enum: ['ok'] },
              version: { type: 'string' },
              uptimeSeconds: { type: 'number' },
              database: {
                type: 'object',
                additionalProperties: false,
                required: ['status'],
                properties: { status: { type: 'string' } },
              },
              integrations: {
                type: 'object',
                additionalProperties: false,
                required: ['github', 'google', 'llm'],
                properties: {
                  github: integrationStatusSchema,
                  google: integrationStatusSchema,
                  llm: integrationStatusSchema,
                },
              },
            },
          },
        },
      },
    },
    async () => ({
      status: 'ok' as const,
      version,
      uptimeSeconds: Math.round(process.uptime()),
      database: databaseStatus(database),
      integrations: {
        github: describe(config.integrations.github.enabled, config.integrations.github.configured),
        google: describe(config.integrations.google.enabled, config.integrations.google.configured),
        // No provider selected is "not configured", not a deliberate opt-out.
        llm: describe(true, config.llm.configured),
      },
    }),
  )
}

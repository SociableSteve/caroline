import type { FastifyInstance } from 'fastify'
import { redactConfig } from '../../config/redact.js'
import type { Config } from '../../config/schema.js'

/**
 * The full effective configuration with every secret field redacted. Spec 09 criterion 8.
 * The response is serialised from the redacted copy rather than filtered by a response
 * schema, so a field added later cannot leak by being forgotten here.
 */
export function registerConfigRoute(app: FastifyInstance, config: Config): void {
  app.get(
    '/api/config',
    {
      // A request schema, and deliberately no response schema: the response is the redacted
      // copy in full, so a field added to the config later is returned rather than silently
      // dropped, and redaction is what keeps it safe. Spec 08 criterion 1 asks that every
      // route declare a schema, not that every route filter its output.
      schema: { querystring: { type: 'object', additionalProperties: false, properties: {} } },
    },
    async () => redactConfig(config),
  )
}

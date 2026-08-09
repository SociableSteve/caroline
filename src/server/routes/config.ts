import type { FastifyInstance } from 'fastify'
import { redactConfig } from '../../config/redact.js'
import type { Config } from '../../config/schema.js'

/**
 * The full effective configuration with every secret field redacted. Spec 09 criterion 8.
 * The response is serialised from the redacted copy rather than filtered by a response
 * schema, so a field added later cannot leak by being forgotten here.
 */
export function registerConfigRoute(app: FastifyInstance, config: Config): void {
  app.get('/api/config', async () => redactConfig(config))
}

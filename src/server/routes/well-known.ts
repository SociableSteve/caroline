/**
 * The two metadata documents a client discovers Caroline through. Spec 12, criterion 26: served
 * where the discovery order a conformant client follows actually looks for them, which is the
 * root, not `/api` (spec 08's named exception to its own "everything is under `/api`" rule).
 *
 * Registered only where `mcp.enabled` is true, exactly as the endpoint itself is (criterion 5):
 * a document describing a service that is not running is not a lesser version of the truth.
 */
import type { FastifyInstance } from 'fastify'
import type { Config } from '../../config/schema.js'
import {
  authorizationServerMetadata,
  protectedResourceMetadata,
  protectedResourceMetadataPath,
} from '../../mcp/oauth/resource.js'

export function registerWellKnownRoutes(app: FastifyInstance, config: Config): void {
  if (!config.mcp.enabled) return

  const resourceMetadata = () => protectedResourceMetadata(config)

  // The path-suffixed document the discovery order tries first, and the unsuffixed one it falls
  // back to permit, both answering with the same content. Spec 12, criterion 26.
  app.get(protectedResourceMetadataPath(), async () => resourceMetadata())
  app.get('/.well-known/oauth-protected-resource', async () => resourceMetadata())

  app.get('/.well-known/oauth-authorization-server', async () =>
    authorizationServerMetadata(config),
  )
}

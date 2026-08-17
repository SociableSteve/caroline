/**
 * The canonical resource URI and the two metadata documents. Spec 12, "The one knowing
 * deviation": both are `http` on loopback by design, which is non-conformant with RFC 8414 and
 * RFC 9728's own `https` requirement, stated here rather than discovered later. What Caroline
 * owes a client instead is internal consistency (criterion 42): the `issuer` below is
 * byte-identical to the identifier a client's well-known URL is built from, and `resource` is
 * this same endpoint's own origin and path, both derived from `server.host` and `server.port`
 * rather than configured, because a configurable identifier could be set to disagree with the
 * address the process is actually reachable at.
 */
import type { Config } from '../../config/schema.js'
import { originFromHostPort } from '../../auth/origin.js'

/** The MCP endpoint's own path, and the resource this whole surface protects. */
export const MCP_RESOURCE_PATH = '/api/mcp'

export function canonicalResourceUri(config: Config): string {
  return `${originFromHostPort('http', config.server.host, config.server.port)}${MCP_RESOURCE_PATH}`
}

function authorizationServerIssuer(config: Config): string {
  return originFromHostPort('http', config.server.host, config.server.port)
}

export interface ProtectedResourceMetadata {
  readonly resource: string
  readonly authorization_servers: readonly string[]
}

/** RFC 9728, served at the well-known path the `WWW-Authenticate` challenge names. */
export function protectedResourceMetadata(config: Config): ProtectedResourceMetadata {
  return {
    resource: canonicalResourceUri(config),
    authorization_servers: [authorizationServerIssuer(config)],
  }
}

/**
 * The path-suffixed document RFC 9728's discovery order tries first: the well-known prefix with
 * the resource's own path appended. The unsuffixed path at the bare well-known root is the
 * fallback that order permits, and both are served with the same content (spec 12, criterion 26).
 */
export function protectedResourceMetadataPath(): string {
  return `/.well-known/oauth-protected-resource${MCP_RESOURCE_PATH}`
}

/** The `resource_metadata` a `401`'s `WWW-Authenticate` challenge names (criteria 8 and 26): the
 * path-suffixed document, which is what a conformant client follows the challenge to. */
export function protectedResourceMetadataUrl(config: Config): string {
  return `${authorizationServerIssuer(config)}${protectedResourceMetadataPath()}`
}

export interface AuthorizationServerMetadata {
  readonly issuer: string
  readonly authorization_endpoint: string
  readonly token_endpoint: string
  readonly response_types_supported: readonly string[]
  readonly grant_types_supported: readonly string[]
  readonly code_challenge_methods_supported: readonly string[]
  readonly token_endpoint_auth_methods_supported: readonly string[]
  readonly client_id_metadata_document_supported: true
  readonly authorization_response_iss_parameter_supported: true
}

/**
 * RFC 8414, amended by MCP's own profile of it: `code_challenge_methods_supported` is what a
 * conformant client refuses to connect without seeing, and `client_id_metadata_document_supported`
 * is what tells a client to skip dynamic registration and use the CIMD route Caroline actually
 * offers, together with `none` in `token_endpoint_auth_methods_supported` (spec 12, "What is
 * deliberately not built"). No `registration_endpoint` is named, because there is none: that is
 * how a client discovers dynamic registration is not on offer, per criterion 31.
 */
export function authorizationServerMetadata(config: Config): AuthorizationServerMetadata {
  const issuer = authorizationServerIssuer(config)
  return {
    issuer,
    authorization_endpoint: `${issuer}/api/mcp/authorize`,
    token_endpoint: `${issuer}/api/mcp/token`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  }
}

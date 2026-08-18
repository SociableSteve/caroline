/**
 * The wire-level shapes and error codes of the MCP revision this surface implements. Spec 12
 * names the revision so that moving to a later one is a decision rather than a drift: `2026-07-28`,
 * published as a release candidate on 2026-05-21 and stable since.
 *
 * This revision's own JSON-RPC error codes are used rather than invented ones, `HeaderMismatch`
 * (`-32020`) included, and the ordinary JSON-RPC 2.0 codes cover the rest: a malformed body, a
 * method nobody registered, and the internal-error catch-all.
 */

/** Asserted by a test, so an upgrade is noticed rather than discovered. */
export const MCP_PROTOCOL_VERSION = '2026-07-28'

/**
 * The version `initialize` falls back to when the requesting client did not ask for
 * `MCP_PROTOCOL_VERSION` by name. It is the `@modelcontextprotocol/sdk`'s own
 * `LATEST_PROTOCOL_VERSION`, the newest entry in that SDK's `SUPPORTED_PROTOCOL_VERSIONS`
 * allowlist as of the client-ecosystem snapshot named in "Version interoperability" in
 * docs/specs/12-mcp-server.md, chosen because it is the one string the client that actually
 * exists today is already prepared to accept, rather than a naive echo of whatever the client
 * sent, which would assert a compatibility Caroline has not decided to hold.
 */
export const MCP_FALLBACK_PROTOCOL_VERSION = '2025-11-25'

export const JSON_RPC_VERSION = '2.0'

export const jsonRpcErrorCodes = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  /** The revision's own: `MCP-Protocol-Version` disagrees with the body. Spec 12, criterion 10. */
  headerMismatch: -32020,
} as const

export interface JsonRpcRequest {
  readonly jsonrpc: string
  readonly id?: string | number | null
  readonly method: string
  readonly params?: unknown
}

export interface JsonRpcSuccess {
  readonly jsonrpc: '2.0'
  readonly id: string | number | null
  readonly result: unknown
}

export interface JsonRpcErrorBody {
  readonly jsonrpc: '2.0'
  readonly id: string | number | null
  readonly error: { readonly code: number; readonly message: string; readonly data?: unknown }
}

export function jsonRpcResult(id: string | number | null, result: unknown): JsonRpcSuccess {
  return { jsonrpc: JSON_RPC_VERSION, id, result }
}

export function jsonRpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcErrorBody {
  return {
    jsonrpc: JSON_RPC_VERSION,
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  }
}

/** A request body that is at least a well-formed JSON-RPC envelope. Anything else is a parse or
 * invalid-request error before any method is looked up. */
export function readEnvelope(body: unknown): JsonRpcRequest | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null

  const candidate = body as Record<string, unknown>
  if (typeof candidate.method !== 'string') return null
  if (candidate.jsonrpc !== undefined && candidate.jsonrpc !== JSON_RPC_VERSION) return null

  const id = candidate.id
  if (id !== undefined && id !== null && typeof id !== 'string' && typeof id !== 'number') {
    return null
  }

  return {
    jsonrpc: JSON_RPC_VERSION,
    ...(id === undefined ? {} : { id: id as string | number | null }),
    method: candidate.method,
    ...(candidate.params === undefined ? {} : { params: candidate.params }),
  }
}

/**
 * JSON-RPC 2.0 (https://www.jsonrpc.org/specification, section 4.1): a Notification is a request
 * with no `id` member at all, and `readEnvelope` above only sets `id` on the returned envelope
 * when the body had one. So this is exactly "was this a Notification", shared by every call site
 * that needs to decide whether a response is owed, rather than each re-deriving it from
 * `envelope.id === undefined` and risking the check drifting between them.
 */
export function isNotification(envelope: JsonRpcRequest): boolean {
  return envelope.id === undefined
}

/**
 * The client's declared name and protocol framing, from `_meta` on the request. Spec 12: every
 * request carries its own framing rather than a handshake, and the client's identity SHOULD
 * travel there too.
 */
export interface RequestMeta {
  readonly protocolVersion: string | null
  readonly clientName: string | null
}

export function readMeta(params: unknown): RequestMeta {
  if (params === null || typeof params !== 'object') {
    return { protocolVersion: null, clientName: null }
  }

  const meta = (params as { _meta?: unknown })._meta
  if (meta === null || typeof meta !== 'object') {
    return { protocolVersion: null, clientName: null }
  }

  const record = meta as Record<string, unknown>
  const protocolVersion = typeof record.protocolVersion === 'string' ? record.protocolVersion : null

  const clientInfo = record.clientInfo
  const clientName =
    clientInfo !== null &&
    typeof clientInfo === 'object' &&
    typeof (clientInfo as Record<string, unknown>).name === 'string'
      ? ((clientInfo as Record<string, unknown>).name as string)
      : null

  return { protocolVersion, clientName }
}

/**
 * The protocol version an `initialize` request actually asked for, read from wherever a real
 * client puts it rather than only where revision `2026-07-28` says it now lives. Before that
 * revision, `protocolVersion` was a top-level field of `initialize`'s `params`; the revision
 * moved it to `params._meta.protocolVersion`, alongside the rest of the framing every other
 * method now carries per-request. Claude Code's shipped MCP client (confirmed on 2.1.233,
 * captured 2026-08-17) sends the legacy top-level shape, having been built before the move, so
 * that field is read first; `_meta.protocolVersion` is read as the fallback for a hypothetical
 * caller native to `2026-07-28` that uses the new shape. Neither present is "no version
 * specified" rather than an error: see "Version interoperability" in
 * docs/specs/12-mcp-server.md.
 */
export function readRequestedProtocolVersion(params: unknown): string | null {
  if (params !== null && typeof params === 'object') {
    const legacy = (params as { protocolVersion?: unknown }).protocolVersion
    if (typeof legacy === 'string') return legacy
  }

  return readMeta(params).protocolVersion
}

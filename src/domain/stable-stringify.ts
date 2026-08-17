/**
 * A JSON encoding that is a function of the value alone, for anything that hashes a value to
 * notice whether it changed. Shared rather than connector-specific: `src/connectors/hash.ts` uses
 * it to notice an upstream item changed, and `src/mcp/call.ts` uses it to digest a tool call's
 * arguments for the audit log, and the MCP surface may import nothing under `src/connectors/`
 * (spec 12, criterion 25), so this lives here rather than in either caller.
 */

/**
 * `JSON.stringify` preserves insertion order, so two objects with the same fields in a
 * different order would encode differently even though they carry the same value. Keys are
 * sorted at every depth to make the encoding a function of the value alone. Arrays keep their
 * order, which is part of their value.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`

  const entries = Object.entries(value as Record<string, unknown>)
    // `undefined` is absent from JSON, so a key holding one is dropped rather than encoded:
    // otherwise `{ a: undefined }` and `{}` would hash differently while encoding the same.
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))

  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`
}

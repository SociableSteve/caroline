/**
 * OpenAI's structured output has two modes. Strict mode guarantees the answer matches the
 * schema, but the request is rejected outright unless the schema stays inside the subset of
 * JSON Schema it supports: every object closed to extra properties, every declared property
 * required, and only certain keywords used at all.
 *
 * Rather than rewrite a schema to fit (which changes what was asked for: making an optional
 * field required is not a formatting detail), the adapter asks whether the schema already
 * qualifies and turns strict mode on when it does. A schema that does not qualify is sent
 * unstrict, and the shared validator in `src/llm/validate.ts` still has the final say either
 * way. Spec 03.
 *
 * The keyword test is an allowlist, not a list of known-bad keywords. The two failure modes
 * are not symmetric: sending a supported schema unstrict costs a guarantee that validation
 * provides anyway, while sending an unsupported one strict fails the whole request. A
 * keyword nobody here has thought about therefore has to fall on the unstrict side, and the
 * supported subset changes often enough that this is not a theoretical concern.
 */
import type { JsonSchema } from '../types.js'

/**
 * The keywords a schema may use and still be sent strict. Deliberately narrower than what
 * OpenAI accepts today: this is the set Caroline's own schemas need, and widening it is a
 * decision to make deliberately rather than one to arrive at by writing a schema.
 */
const allowedKeywords = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'anyOf',
  'enum',
  'const',
  'description',
  'title',
  '$defs',
  '$ref',
  '$schema',
])

function asSchema(value: unknown): JsonSchema | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonSchema)
    : null
}

export function isStrictCompatible(schema: JsonSchema): boolean {
  if (Object.keys(schema).some((keyword) => !allowedKeywords.has(keyword))) return false

  // A union type such as `["object", "null"]` is not rejected for being a union, but it is
  // not read as an object either, so the object rules below would be skipped for something
  // that can still be one. Requiring a single named type keeps the check honest.
  if (schema.type !== undefined && typeof schema.type !== 'string') return false

  const properties = asSchema(schema.properties)

  if (schema.type === 'object') {
    if (schema.additionalProperties !== false) return false

    const names = properties === null ? [] : Object.keys(properties)
    const required = Array.isArray(schema.required) ? schema.required : []
    if (names.some((name) => !required.includes(name))) return false
  }

  // Every subschema has to qualify too, or the request is rejected for the nested one.
  // Tuple form (`items` as an array) is walked entry by entry rather than treated as one
  // child, which would have skipped all of them.
  for (const nested of [
    ...(properties === null ? [] : Object.values(properties)),
    ...(asSchema(schema.$defs) === null ? [] : Object.values(schema.$defs as JsonSchema)),
    ...(Array.isArray(schema.items) ? schema.items : [schema.items]),
    ...(Array.isArray(schema.anyOf) ? schema.anyOf : []),
  ]) {
    const child = asSchema(nested)
    if (child !== null && !isStrictCompatible(child)) return false
  }

  return true
}

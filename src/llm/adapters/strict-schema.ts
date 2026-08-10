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
 * The test is an allowlist, not a list of known-bad keywords. The two failure modes are not
 * symmetric: sending a supported schema unstrict costs a guarantee that validation provides
 * anyway, while sending an unsupported one strict fails the whole request. A keyword nobody
 * here has thought about therefore has to fall on the unstrict side, and the supported
 * subset changes often enough that this is not a theoretical concern.
 *
 * Each keyword's value is checked as well as its name, and for the same reason. A schema
 * carrying `{ items: 1 }` is malformed rather than unsupported, but it is no more sendable
 * for that, and a name-only check would wave it through on the grounds that `items` is a
 * keyword it recognises.
 */
import type { JsonSchema } from '../types.js'

function isSchema(value: unknown): value is JsonSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** An object whose every value is itself a schema, which is what `properties` and `$defs` are. */
function isSchemaMap(value: unknown): boolean {
  return isSchema(value) && Object.values(value).every(isSchema)
}

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

/**
 * The keywords a schema may use and still be sent strict, each with what it must look like.
 * Deliberately narrower than what OpenAI accepts today: this is the set Caroline's own
 * schemas need, and widening it is a decision to make deliberately rather than one to arrive
 * at by writing a schema. A keyword absent from this table is by definition not allowed.
 */
const wellFormed: Record<string, (value: unknown) => boolean> = {
  // A union such as `["object", "null"]` is not rejected for being a union so much as for
  // being unreadable here: the object rules below would be skipped for something that can
  // still be an object.
  type: (value) => typeof value === 'string',
  properties: isSchemaMap,
  required: isStringArray,
  // A schema-valued `additionalProperties` is legal JSON Schema, but the object rule below
  // is about the literal `false`, so anything else falls to the unstrict side.
  additionalProperties: (value) => typeof value === 'boolean',
  // Both forms: one schema for every entry, or the tuple form of one schema per position.
  items: (value) => isSchema(value) || (Array.isArray(value) && value.every(isSchema)),
  anyOf: (value) => Array.isArray(value) && value.length > 0 && value.every(isSchema),
  enum: (value) => Array.isArray(value) && value.length > 0,
  const: () => true,
  description: (value) => typeof value === 'string',
  title: (value) => typeof value === 'string',
  $defs: isSchemaMap,
  $ref: (value) => typeof value === 'string',
  $schema: (value) => typeof value === 'string',
}

export function isStrictCompatible(schema: JsonSchema): boolean {
  for (const [keyword, value] of Object.entries(schema)) {
    if (wellFormed[keyword]?.(value) !== true) return false
  }

  const properties = isSchema(schema.properties) ? schema.properties : null

  if (schema.type === 'object') {
    if (schema.additionalProperties !== false) return false

    const names = properties === null ? [] : Object.keys(properties)
    const required = Array.isArray(schema.required) ? schema.required : []
    if (names.some((name) => !required.includes(name))) return false
  }

  // Every subschema has to qualify too, or the request is rejected for the nested one. The
  // shapes are already known good by the table above, so anything reached here is a schema.
  for (const nested of [
    ...(properties === null ? [] : Object.values(properties)),
    ...(isSchema(schema.$defs) ? Object.values(schema.$defs) : []),
    ...(Array.isArray(schema.items) ? schema.items : [schema.items]),
    ...(Array.isArray(schema.anyOf) ? schema.anyOf : []),
  ]) {
    if (isSchema(nested) && !isStrictCompatible(nested)) return false
  }

  return true
}

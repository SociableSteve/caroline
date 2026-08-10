/**
 * OpenAI's structured output has two modes. Strict mode guarantees the answer matches the
 * schema, but the request is rejected outright unless the schema meets its rules: every
 * object closed to extra properties, and every declared property listed as required.
 *
 * Rather than rewrite a schema to fit (which changes what was asked for: making an optional
 * field required is not a formatting detail), the adapter asks whether the schema already
 * qualifies and turns strict mode on when it does. A schema that does not qualify is sent
 * unstrict, and the shared validator in `src/llm/validate.ts` still has the final say either
 * way. Spec 03.
 */
import type { JsonSchema } from '../types.js'

function asSchema(value: unknown): JsonSchema | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonSchema)
    : null
}

export function isStrictCompatible(schema: JsonSchema): boolean {
  const properties = asSchema(schema.properties)

  if (schema.type === 'object') {
    if (schema.additionalProperties !== false) return false

    const names = properties === null ? [] : Object.keys(properties)
    const required = Array.isArray(schema.required) ? schema.required : []
    if (names.some((name) => !required.includes(name))) return false
  }

  // Every subschema has to qualify too, or the request is rejected for the nested one.
  for (const nested of [
    ...(properties === null ? [] : Object.values(properties)),
    schema.items,
    ...(Array.isArray(schema.anyOf) ? schema.anyOf : []),
    ...(Array.isArray(schema.oneOf) ? schema.oneOf : []),
    ...(Array.isArray(schema.allOf) ? schema.allOf : []),
  ]) {
    const child = asSchema(nested)
    if (child !== null && !isStrictCompatible(child)) return false
  }

  return true
}

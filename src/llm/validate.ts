/**
 * Schema validation, in shared code rather than in an adapter. Each provider is asked for
 * structured output by a different mechanism (a forced tool, a response format, a `format`
 * field), and each of them can be talked out of it, so what comes back is checked here
 * against the same schema object that was sent. Spec 03.
 */
import { Ajv, type ValidateFunction } from 'ajv'
import type { JsonSchema } from './types.js'

/**
 * `strict: false` because the schemas are written to be sent to three providers as well as
 * validated here, and each of them tolerates a slightly different set of annotations. Ajv's
 * strict mode would reject a schema the provider was perfectly happy with, at startup of a
 * job rather than in review.
 */
const ajv = new Ajv({ allErrors: true, strict: false })

/**
 * Compiling is the expensive part and a schema is a module-level constant at every call
 * site, so each one is compiled once. Keyed weakly, so a schema built per call still gets
 * collected rather than leaking a validator per request.
 */
const compiled = new WeakMap<JsonSchema, ValidateFunction>()

function validatorFor(schema: JsonSchema): ValidateFunction {
  const existing = compiled.get(schema)
  if (existing !== undefined) return existing

  const validate = ajv.compile(schema)
  compiled.set(schema, validate)
  return validate
}

export type ValidationOutcome =
  | { readonly valid: true }
  /** Every failure, in one line, because it is fed back to the model on the retry. */
  | { readonly valid: false; readonly message: string }

export function validateAgainstSchema(schema: JsonSchema, value: unknown): ValidationOutcome {
  if (value === undefined) {
    return { valid: false, message: 'the provider returned no structured output' }
  }

  const validate = validatorFor(schema)
  if (validate(value)) return { valid: true }

  const detail = (validate.errors ?? [])
    .map((error) => `${error.instancePath === '' ? '(root)' : error.instancePath} ${error.message}`)
    .join('; ')

  return { valid: false, message: detail === '' ? 'the answer did not match the schema' : detail }
}

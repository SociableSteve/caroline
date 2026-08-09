import { Writable } from 'node:stream'
import type { FastifyRequest } from 'fastify'
import { redactSecrets } from '../config/redact.js'
import type { Config } from '../config/schema.js'

/**
 * Redaction happens at three points, because scrubbing the finished log line cannot be
 * made sufficient on its own. By the time a line reaches the stream it has been through
 * JSON encoding, and an encoded secret no longer matches the secret: `tok"en` is written
 * as `tok\"en`. The same is true of any other encoding a value passes through on its way
 * in, so the fix is to redact values before they are encoded, and to remove the one place
 * a caller controls the bytes. Spec 09 criterion 6.
 */

/** Logged in place of a route for a request that matched none. */
export const UNMATCHED_ROUTE = '(unmatched)'

/**
 * Requests are identified by the route they matched, not by the URL they arrived on. Every
 * byte of that URL is chosen by the caller, path as much as query string, so a secret can
 * be smuggled into a log line in any encoding the caller likes: `/api/%67%68%70...` is not
 * the literal secret and never will be. The route template is written in this repository
 * and matching it is what makes the smuggling impossible rather than merely harder. A
 * request that matched no route contributes no route bytes at all.
 */
export function requestSerialiser() {
  return (request: FastifyRequest) => ({
    method: request.method,
    route: request.routeOptions.url ?? UNMATCHED_ROUTE,
    remoteAddress: request.ip,
  })
}

/**
 * Errors are serialised here rather than by pino's default, so the message and stack are
 * redacted while they are still strings. Upstream libraries put tokens in both.
 */
export function errorSerialiser(config: Config) {
  return (error: Error & { code?: string; statusCode?: number }) => ({
    type: error.name,
    message: redactSecrets(error.message, config),
    stack: redactSecrets(error.stack ?? '', config),
    ...(error.code === undefined ? {} : { code: error.code }),
    ...(error.statusCode === undefined ? {} : { statusCode: error.statusCode }),
  })
}

/**
 * Redacts every string in a log payload, in place of the object pino would serialise.
 * Only plain objects and arrays are rebuilt: anything with its own prototype is left for
 * its serialiser.
 *
 * Property names are redacted as well as values, because a name is JSON-encoded on the way
 * out exactly as a value is, and a secret used as a field name would reach the stream in a
 * form the scrubber can no longer match.
 *
 * A payload can reference the same object twice, and a second visit must not hand back the
 * original: that object still holds the secret, and returning it would leave one occurrence
 * redacted and the other not. Each object is mapped to its own replacement before its
 * contents are walked, so repeated references share the redacted copy and a cycle
 * terminates on the copy rather than on the original.
 */
export function redactLogPayload(
  value: unknown,
  config: Config,
  replacements: WeakMap<object, unknown> = new WeakMap(),
): unknown {
  if (typeof value === 'string') return redactSecrets(value, config)
  if (value === null || typeof value !== 'object') return value

  const existing = replacements.get(value)
  if (existing !== undefined) return existing

  if (Array.isArray(value)) {
    const copy: unknown[] = []
    replacements.set(value, copy)
    for (const item of value) copy.push(redactLogPayload(item, config, replacements))
    return copy
  }

  const prototype = Object.getPrototypeOf(value) as object | null
  if (prototype !== Object.prototype && prototype !== null) return value

  const copy: Record<string, unknown> = {}
  replacements.set(value, copy)
  for (const [key, item] of Object.entries(value)) {
    copy[redactSecrets(key, config)] = redactLogPayload(item, config, replacements)
  }
  return copy
}

/**
 * The last line of defence, for anything that reached the destination without passing
 * through the points above. Literal matching only, by the reasoning in `redactSecrets`.
 */
export function scrubbingStream(destination: NodeJS.WritableStream, config: Config): Writable {
  return new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      destination.write(redactSecrets(String(chunk), config))
      callback()
    },
  })
}

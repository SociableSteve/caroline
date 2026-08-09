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

/**
 * Request logging without the query string. Nothing this application puts in a query
 * string is worth a log line, and it is the only part of a request whose bytes a caller
 * chooses freely: dropping it removes every encoding of a secret at once, which matching
 * the encodings one at a time cannot do. Method and path still identify the request, and
 * the path is redacted because a route parameter can carry a secret literally.
 */
export function requestSerialiser(config: Config) {
  return (request: FastifyRequest) => ({
    method: request.method,
    path: redactSecrets(request.url.split('?')[0] ?? request.url, config),
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
 * its serialiser, and already-visited objects are returned as they are so a cyclic payload
 * cannot loop.
 */
export function redactLogPayload(
  value: unknown,
  config: Config,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (typeof value === 'string') return redactSecrets(value, config)
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return value
  seen.add(value)

  if (Array.isArray(value)) return value.map((item) => redactLogPayload(item, config, seen))

  const prototype = Object.getPrototypeOf(value) as object | null
  if (prototype !== Object.prototype && prototype !== null) return value

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, redactLogPayload(item, config, seen)]),
  )
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

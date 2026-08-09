import { Writable } from 'node:stream'
import { secretValues } from '../config/redact.js'
import { REDACTED } from '../config/redact.js'
import type { Config } from '../config/schema.js'

/**
 * Wraps a log destination so no configured secret can reach it, whatever put it there:
 * a URL, an upstream library's error text, a serialised request. Scrubbing at the stream
 * is the only place that covers all of them. Spec 09 criterion 6.
 */
export function scrubbingStream(destination: NodeJS.WritableStream, config: Config): Writable {
  const secrets = secretValues(config)

  return new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      const line = secrets.reduce(
        (scrubbed, secret) => scrubbed.split(secret).join(REDACTED),
        String(chunk),
      )
      destination.write(line)
      callback()
    },
  })
}

import { Writable } from 'node:stream'

/** A writable that keeps every line rather than writing to a real stream, so a test can pass it
 * as a pino destination and assert on what was logged. */
export function captureLog(): { lines: string[]; stream: Writable } {
  const lines: string[] = []
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk))
      callback()
    },
  })
  return { lines, stream }
}

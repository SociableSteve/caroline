import type { FastifyInstance } from 'fastify'
import type { ChangeFeed } from '../changes.js'

/**
 * How often a comment line is sent on an idle stream. Proxies and browsers drop a
 * connection that says nothing for long enough, and a comment is the cheapest thing that
 * counts as saying something.
 */
export const HEARTBEAT_MS = 25_000

export interface ChangesRouteOptions {
  /** Shortened by the tests. Nothing else has a reason to change it. */
  heartbeatMs?: number
}

/**
 * The change feed as server-sent events. Fastify is handed off with `hijack` because the
 * response is a stream that never ends: there is no payload for it to serialise and no
 * point at which it would send one.
 */
export function registerChangesRoute(
  app: FastifyInstance,
  changes: ChangeFeed,
  { heartbeatMs = HEARTBEAT_MS }: ChangesRouteOptions = {},
): void {
  app.get(
    '/api/changes',
    {
      schema: {
        querystring: { type: 'object', additionalProperties: false, properties: {} },
      },
    },
    (request, reply) => {
      reply.hijack()

      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // Nginx and friends buffer a response body by default, which for a stream means
        // holding every event until the connection closes.
        'x-accel-buffering': 'no',
      })
      reply.raw.write(': open\n\n')

      const unsubscribe = changes.subscribe((event) => {
        reply.raw.write(`event: change\ndata: ${JSON.stringify(event)}\n\n`)
      })

      const heartbeat = setInterval(() => reply.raw.write(': heartbeat\n\n'), heartbeatMs)
      // An open stream is not a reason to keep the process alive on shutdown.
      heartbeat.unref()

      const close = () => {
        clearInterval(heartbeat)
        unsubscribe()
      }

      // `close` covers the client going away and the server closing the socket alike, and
      // fires once either way, so the subscription cannot outlive the response.
      reply.raw.on('close', close)
      request.raw.on('close', close)
    },
  )
}

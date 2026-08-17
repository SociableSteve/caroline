import type { FastifyInstance } from 'fastify'
import { onSessionEnded } from '../../auth/revocation.js'
import type { ChangeFeed } from '../changes.js'

/** What the route needs to notice its own session expiring while nothing else visits the row. */
export interface SessionLivenessChecker {
  sessionStillValid(id: string): boolean
}

/**
 * How often a comment line is sent on an idle stream. Proxies and browsers drop a
 * connection that says nothing for long enough, and a comment is the cheapest thing that
 * counts as saying something.
 */
export const HEARTBEAT_MS = 25_000

export interface ChangesRouteOptions {
  /** Shortened by the tests. Nothing else has a reason to change it. */
  heartbeatMs?: number
  /**
   * Where `authRequired` is true, checked on every heartbeat tick against the stream's own
   * session id: an idle feed has nothing else visiting the row, so this is what notices its
   * session expiring. Spec 13, criterion 22.
   */
  auth?: SessionLivenessChecker
}

/**
 * The change feed as server-sent events. Fastify is handed off with `hijack` because the
 * response is a stream that never ends: there is no payload for it to serialise and no
 * point at which it would send one.
 *
 * Subscriptions are keyed by session (spec 13, criterion 22): where `authRequired` is true, the
 * auth gate has already put the session's id on `request.sessionId`, and this route listens for
 * that session ending and closes the stream when it does. `EventSource` reconnects by itself,
 * and the reconnect is answered 401 by the gate, which is what turns the closed stream into the
 * login screen on the client.
 */
export function registerChangesRoute(
  app: FastifyInstance,
  changes: ChangeFeed,
  { heartbeatMs = HEARTBEAT_MS, auth }: ChangesRouteOptions = {},
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

      const heartbeat = setInterval(() => {
        // Nothing else visits this session's row while the feed sits idle, so this tick is the
        // only thing that ever notices its session has expired: `sessionStillValid` revokes the
        // row itself where it has, and the stream is ended here exactly as the revocation
        // listener below ends it on an explicit logout. Spec 13, criterion 22.
        if (
          request.sessionId !== null &&
          request.sessionId !== undefined &&
          auth !== undefined &&
          !auth.sessionStillValid(request.sessionId)
        ) {
          close()
          reply.raw.end()
          return
        }
        reply.raw.write(': heartbeat\n\n')
      }, heartbeatMs)
      // An open stream is not a reason to keep the process alive on shutdown.
      heartbeat.unref()

      const close = () => {
        clearInterval(heartbeat)
        unsubscribe()
        stopListeningForRevocation()
      }

      // `close` covers the client going away and the server closing the socket alike, and
      // fires once either way, so the subscription cannot outlive the response.
      reply.raw.on('close', close)
      request.raw.on('close', close)

      const stopListeningForRevocation = onSessionEnded(request.sessionId, () => {
        close()
        // Actively ends the stream: the client did nothing wrong, its session did.
        // `EventSource` treats this as a disconnect and reconnects, and the reconnect is
        // what the gate answers 401 (criterion 22).
        reply.raw.end()
      })
    },
  )
}

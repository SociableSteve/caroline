/**
 * The logger as the rest of the process sees it. Spec 14.
 *
 * A narrow interface rather than the server's logger type, because the jobs, the connectors, the
 * provider and the MCP surface all log and none of them should have to know what a Fastify instance
 * is. Fastify's own logger satisfies it structurally, so the server passes `app.log` and nothing
 * adapts anything.
 *
 * Every call takes fields and a message, in that order, and the fields hold ids, counts, statuses,
 * durations and decisions. An item's own text is never one of them, at any level: spec 14 states
 * that as a contract with a criterion and a test, because the natural way to make a log more useful
 * is to put more of the item in it.
 */
export interface OperationalLog {
  trace(fields: Record<string, unknown>, message: string): void
  debug(fields: Record<string, unknown>, message: string): void
  info(fields: Record<string, unknown>, message: string): void
  warn(fields: Record<string, unknown>, message: string): void
  error(fields: Record<string, unknown>, message: string): void
}

/** For a caller with nowhere to log: the payload preview, and most of the suite. */
export function silentLog(): OperationalLog {
  return {
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }
}

export interface DeferredLog extends OperationalLog {
  /** Points this at the real logger. Anything logged before it is called goes nowhere. */
  attach(target: OperationalLog): void
}

/**
 * A handle that becomes the logger once there is one.
 *
 * The jobs are built before the server, and the server is what owns the logger, so something has to
 * bridge the two. This is that bridge rather than a second logger: `main.ts` attaches `app.log` the
 * moment the server exists, which is before the scheduler starts and before any job or connector
 * runs. Nothing logs during construction, so nothing is lost in the gap.
 */
export function deferredLog(): DeferredLog {
  let target: OperationalLog | null = null

  const at =
    (level: keyof OperationalLog) =>
    (fields: Record<string, unknown>, message: string): void => {
      target?.[level](fields, message)
    }

  return {
    trace: at('trace'),
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    attach(next: OperationalLog) {
      target = next
    },
  }
}

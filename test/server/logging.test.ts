import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config/load.js'
import type { Config } from '../../src/config/schema.js'
import { buildServer } from '../../src/server/app.js'
import { migratedDatabase } from '../helpers/temp-database.js'
import { NO_BUILT_WEB_ROOT } from '../helpers/test-server.js'
import { createLogDestination } from '../../src/server/log-destination.js'
import { deferredLog } from '../../src/server/log.js'
import { LOG_FILE_NAME } from '../../src/server/log-file.js'
import { UNMATCHED_ROUTE } from '../../src/server/log-redaction.js'
import { captureLog } from '../helpers/log-capture.js'

const secrets = {
  ANTHROPIC_API_KEY: 'sk-ant-supersecret',
  GITHUB_TOKEN: 'ghp_supersecret',
  CAROLINE_AUTH_CLIENT_SECRET: 'access-supersecret',
} as NodeJS.ProcessEnv

describe('request URLs never reach a log line', () => {
  it('logs the matched route, not the URL the caller sent', async () => {
    const { lines, stream } = captureLog()
    const config = loadConfig({ file: null, env: secrets })
    const app = await buildServer({
      config,
      database: migratedDatabase(),
      logger: { level: 'info', stream },
    })

    await app.inject({ method: 'GET', url: '/api/health?verbose=true&token=anything-at-all' })
    await app.close()

    const logged = lines.join('\n')
    expect(logged).toContain('"route":"/api/health"')
    expect(logged).not.toContain('anything-at-all')
    expect(logged).not.toContain('verbose=true')
    expect(logged).not.toContain('?')
  })

  it('logs no URL bytes at all for a request that matched no route', async () => {
    const { lines, stream } = captureLog()
    const config = loadConfig({ file: null, env: secrets })
    const app = await buildServer({
      config,
      database: migratedDatabase(),
      logger: { level: 'info', stream },
      webRoot: NO_BUILT_WEB_ROOT,
    })

    await app.inject({ method: 'GET', url: '/api/no-such-route-abcdef' })
    await app.close()

    const logged = lines.join('\n')
    expect(logged).toContain(UNMATCHED_ROUTE)
    expect(logged).not.toContain('no-such-route-abcdef')
  })
})

describe('secrets are redacted before the log line is serialised', () => {
  it('redacts a secret whose characters JSON escaping would rewrite', async () => {
    const secretNeedingEscapes = 'tok"en\\value'
    const { lines, stream } = captureLog()
    const config = loadConfig({
      file: null,
      env: { CAROLINE_AUTH_CLIENT_SECRET: secretNeedingEscapes } as NodeJS.ProcessEnv,
    })
    const app = await buildServer({
      config,
      database: migratedDatabase(),
      logger: { level: 'info', stream },
    })

    app.get('/api/boom', async () => {
      throw new Error(`upstream rejected ${secretNeedingEscapes}`)
    })

    await app.inject({ method: 'GET', url: '/api/boom' })
    await app.close()

    const logged = lines.join('\n')
    const jsonEscaped = JSON.stringify(secretNeedingEscapes).slice(1, -1)
    expect(logged).not.toContain(secretNeedingEscapes)
    expect(logged).not.toContain(jsonEscaped)
  })

  it('redacts a secret logged as a structured field', async () => {
    const { lines, stream } = captureLog()
    const config = loadConfig({ file: null, env: secrets })
    const app = await buildServer({
      config,
      database: migratedDatabase(),
      logger: { level: 'info', stream },
    })

    app.log.info({ upstream: { token: 'ghp_supersecret' } }, 'calling upstream')
    await app.close()

    expect(lines.join('\n')).not.toContain('ghp_supersecret')
  })

  it('redacts a secret appearing in the log message itself', async () => {
    const { lines, stream } = captureLog()
    const config = loadConfig({ file: null, env: secrets })
    const app = await buildServer({
      config,
      database: migratedDatabase(),
      logger: { level: 'info', stream },
    })

    app.log.info('calling upstream with ghp_supersecret')
    await app.close()

    expect(lines.join('\n')).not.toContain('ghp_supersecret')
  })
})

describe('no secret reaches a log line (spec 09 criterion 6)', () => {
  it('keeps secrets out of request logging, even when one appears in the URL', async () => {
    const { lines, stream } = captureLog()
    const config = loadConfig({ file: null, env: secrets })
    const app = await buildServer({
      config,
      database: migratedDatabase(),
      logger: { level: 'info', stream },
    })

    await app.inject({ method: 'GET', url: '/api/health?token=ghp_supersecret' })
    await app.inject({ method: 'GET', url: '/api/sk-ant-supersecret' })
    await app.close()

    const logged = lines.join('\n')
    for (const secret of Object.values(secrets) as string[]) {
      expect(logged).not.toContain(secret)
    }
  })

  it('keeps a percent-encoded secret out of request logging', async () => {
    const secretWithReservedChars = 'access+token/value'
    const { lines, stream } = captureLog()
    const config = loadConfig({
      file: null,
      env: { CAROLINE_AUTH_CLIENT_SECRET: secretWithReservedChars } as NodeJS.ProcessEnv,
    })
    const app = await buildServer({
      config,
      database: migratedDatabase(),
      logger: { level: 'info', stream },
    })

    const encoded = encodeURIComponent(secretWithReservedChars)
    await app.inject({ method: 'GET', url: `/api/health?token=${encoded}` })
    await app.close()

    expect(lines.join('\n')).not.toContain(encoded)
  })

  it('keeps a lower-case percent-encoded secret out of request logging', async () => {
    const secretWithReservedChars = 'access+token/value'
    const { lines, stream } = captureLog()
    const config = loadConfig({
      file: null,
      env: { CAROLINE_AUTH_CLIENT_SECRET: secretWithReservedChars } as NodeJS.ProcessEnv,
    })
    const app = await buildServer({
      config,
      database: migratedDatabase(),
      logger: { level: 'info', stream },
    })

    await app.inject({ method: 'GET', url: '/api/health?token=access%2btoken%2fvalue' })
    await app.close()

    expect(lines.join('\n')).not.toContain('access%2btoken%2fvalue')
  })

  it('keeps a percent-encoded secret in the path out of request logging', async () => {
    const secretInPath = 'access-supersecret'
    const { lines, stream } = captureLog()
    const config = loadConfig({ file: null, env: secrets })
    const app = await buildServer({
      config,
      database: migratedDatabase(),
      logger: { level: 'info', stream },
    })

    const percentEncodedPerCharacter = [...secretInPath]
      .map((character) => `%${character.charCodeAt(0).toString(16).padStart(2, '0')}`)
      .join('')
    await app.inject({ method: 'GET', url: `/api/${percentEncodedPerCharacter}` })
    await app.close()

    expect(lines.join('\n')).not.toContain(percentEncodedPerCharacter)
  })

  it('redacts a secret used as a log field name', async () => {
    const secretNeedingEscapes = 'tok"en\\value'
    const { lines, stream } = captureLog()
    const config = loadConfig({
      file: null,
      env: { CAROLINE_AUTH_CLIENT_SECRET: secretNeedingEscapes } as NodeJS.ProcessEnv,
    })
    const app = await buildServer({
      config,
      database: migratedDatabase(),
      logger: { level: 'info', stream },
    })

    app.log.info({ [secretNeedingEscapes]: 'value' }, 'calling upstream')
    await app.close()

    const logged = lines.join('\n')
    const jsonEscaped = JSON.stringify(secretNeedingEscapes).slice(1, -1)
    expect(logged).not.toContain(secretNeedingEscapes)
    expect(logged).not.toContain(jsonEscaped)
  })

  it('redacts every occurrence of an object referenced more than once', async () => {
    const secretNeedingEscapes = 'tok"en\\value'
    const { lines, stream } = captureLog()
    const config = loadConfig({
      file: null,
      env: { CAROLINE_AUTH_CLIENT_SECRET: secretNeedingEscapes } as NodeJS.ProcessEnv,
    })
    const app = await buildServer({
      config,
      database: migratedDatabase(),
      logger: { level: 'info', stream },
    })

    const sharedCredentials = { token: secretNeedingEscapes }
    app.log.info({ primary: sharedCredentials, fallback: sharedCredentials }, 'calling upstream')
    await app.close()

    const logged = lines.join('\n')
    const jsonEscaped = JSON.stringify(secretNeedingEscapes).slice(1, -1)
    expect(logged).not.toContain(secretNeedingEscapes)
    expect(logged).not.toContain(jsonEscaped)
  })

  it('redacts a secret held by an object that is not a plain object', async () => {
    const secretNeedingEscapes = 'tok"en\\value'
    class Credentials {
      constructor(readonly token: string) {}
    }
    const { lines, stream } = captureLog()
    const config = loadConfig({
      file: null,
      env: { CAROLINE_AUTH_CLIENT_SECRET: secretNeedingEscapes } as NodeJS.ProcessEnv,
    })
    const app = await buildServer({
      config,
      database: migratedDatabase(),
      logger: { level: 'info', stream },
    })

    app.log.info({ upstream: new Credentials(secretNeedingEscapes) }, 'calling upstream')
    app.log.info({ pool: [new Credentials(secretNeedingEscapes)] }, 'calling upstream')
    await app.close()

    const logged = lines.join('\n')
    const jsonEscaped = JSON.stringify(secretNeedingEscapes).slice(1, -1)
    expect(logged).not.toContain(secretNeedingEscapes)
    expect(logged).not.toContain(jsonEscaped)
    expect(logged).toContain('[redacted]')
  })

  it('redacts, rather than silently drops, an own __proto__ field', async () => {
    const secretNeedingEscapes = 'tok"en\\value'
    const { lines, stream } = captureLog()
    const config = loadConfig({
      file: null,
      env: { CAROLINE_AUTH_CLIENT_SECRET: secretNeedingEscapes } as NodeJS.ProcessEnv,
    })
    const app = await buildServer({
      config,
      database: migratedDatabase(),
      logger: { level: 'info', stream },
    })

    // JSON.parse is how an own, enumerable `__proto__` reaches a log payload in practice:
    // an upstream response parsed and then logged. An object literal would set the
    // prototype instead of creating the field, so the fixture has to come from real JSON.
    const parsedUpstreamBody: unknown = JSON.parse(
      `{"__proto__":{"token":${JSON.stringify(secretNeedingEscapes)}}}`,
    )
    app.log.info({ upstream: parsedUpstreamBody }, 'calling upstream')
    await app.close()

    const logged = lines.join('\n')
    const jsonEscaped = JSON.stringify(secretNeedingEscapes).slice(1, -1)
    expect(logged).not.toContain(secretNeedingEscapes)
    expect(logged).not.toContain(jsonEscaped)
    expect(logged).toContain('__proto__')
    expect(logged).toContain('[redacted]')
  })

  it('redacts a secret held by an error nested inside a payload', async () => {
    const secretNeedingEscapes = 'tok"en\\value'
    class UpstreamError extends Error {
      constructor(readonly token: string) {
        super('upstream rejected')
      }
      toJSON() {
        return { message: this.message, token: this.token }
      }
    }
    const { lines, stream } = captureLog()
    const config = loadConfig({
      file: null,
      env: { CAROLINE_AUTH_CLIENT_SECRET: secretNeedingEscapes } as NodeJS.ProcessEnv,
    })
    const app = await buildServer({
      config,
      database: migratedDatabase(),
      logger: { level: 'info', stream },
    })

    app.log.info({ cause: new UpstreamError(secretNeedingEscapes) }, 'call failed')
    await app.close()

    const logged = lines.join('\n')
    const jsonEscaped = JSON.stringify(secretNeedingEscapes).slice(1, -1)
    expect(logged).not.toContain(secretNeedingEscapes)
    expect(logged).not.toContain(jsonEscaped)
    expect(logged).toContain('[redacted]')
  })

  it('still lets the error serialiser shape an error, redacted', async () => {
    const { lines, stream } = captureLog()
    const config = loadConfig({ file: null, env: secrets })
    const app = await buildServer({
      config,
      database: migratedDatabase(),
      logger: { level: 'info', stream },
    })

    app.log.error({ err: new Error('upstream rejected ghp_supersecret') }, 'call failed')
    await app.close()

    const logged = lines.join('\n')
    expect(logged).toContain('"type":"Error"')
    expect(logged).toContain('upstream rejected [redacted]')
    expect(logged).not.toContain('ghp_supersecret')
  })

  it('keeps secrets out of a logged error message', async () => {
    const { lines, stream } = captureLog()
    const config = loadConfig({ file: null, env: secrets })
    const app = await buildServer({
      config,
      database: migratedDatabase(),
      logger: { level: 'info', stream },
    })

    app.get('/api/boom', async () => {
      throw new Error('upstream rejected token ghp_supersecret')
    })

    const response = await app.inject({ method: 'GET', url: '/api/boom' })
    await app.close()

    expect(response.statusCode).toBe(500)
    expect(response.body).not.toContain('ghp_supersecret')
    expect(lines.join('\n')).not.toContain('ghp_supersecret')
  })
})

/**
 * The durable destination. Spec 14 puts the file behind the same scrubbing stream stdout is behind,
 * so spec 09 criterion 6 is asserted here against the file on disk rather than only against a stream
 * a test injected.
 */
describe('the durable log file (spec 14 criteria 1, 2, 6 and 7; spec 09 criterion 6)', () => {
  const directories: string[] = []

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  function temporaryDirectory(): string {
    const created = mkdtempSync(join(tmpdir(), 'caroline-log-'))
    directories.push(created)
    return created
  }

  /** A configuration whose log file is in a directory of this test's own. */
  function loggingTo(directory: string): Config {
    return loadConfig({ file: { logging: { file: { directory } } }, env: secrets })
  }

  /** Everything in the log file, as one string. */
  function logged(directory: string): string {
    return readFileSync(join(directory, LOG_FILE_NAME), 'utf8')
  }

  it('writes the same lines to the file and to stdout', async () => {
    const directory = temporaryDirectory()
    const config = loggingTo(directory)
    const { lines, stream: terminal } = captureLog()
    const destination = createLogDestination({ config, stdout: terminal })
    const app = await buildServer({
      config,
      database: migratedDatabase(),
      logger: { level: 'info', stream: destination.stream },
    })

    await app.inject({ method: 'GET', url: '/api/health' })
    await app.close()
    destination.close()

    expect(logged(directory)).toContain('"route":"/api/health"')
    expect(lines.join('')).toBe(logged(directory))
  })

  it('keeps a secret written at the most verbose level out of the file', async () => {
    const directory = temporaryDirectory()
    const config = loggingTo(directory)
    const destination = createLogDestination({ config, stdout: captureLog().stream })
    const app = await buildServer({
      config,
      database: migratedDatabase(),
      logger: { level: 'trace', stream: destination.stream },
    })

    app.log.trace({ upstream: { token: 'ghp_supersecret' } }, 'calling upstream')
    app.log.debug('calling upstream with sk-ant-supersecret')
    app.log.trace({ 'access-supersecret': 'used as a field name' }, 'calling upstream')
    await app.close()
    destination.close()

    const contents = logged(directory)
    for (const secret of Object.values(secrets) as string[]) {
      expect(contents).not.toContain(secret)
    }
    expect(contents).toContain('[redacted]')
  })

  it('keeps writing the file when stdout has gone away', async () => {
    const directory = temporaryDirectory()
    const config = loggingTo(directory)
    // A pipe whose reader has gone: the write throws rather than returning false.
    const closedTerminal = new Writable({
      write() {
        throw new Error('EPIPE: broken pipe')
      },
    })
    const destination = createLogDestination({ config, stdout: closedTerminal })
    const app = await buildServer({
      config,
      database: migratedDatabase(),
      logger: { level: 'info', stream: destination.stream },
    })

    app.log.info({ first: true }, 'before the pipe closed')
    app.log.info({ second: true }, 'after the pipe closed')
    await app.close()
    destination.close()

    const contents = logged(directory)
    expect(contents).toContain('before the pipe closed')
    expect(contents).toContain('after the pipe closed')
    // Said once, into the file, rather than per line for the rest of the process's life.
    expect(contents.match(/no longer write log lines to stdout/g)).toHaveLength(1)
  })

  it('keeps serving and keeps writing stdout when the log file cannot be opened', async () => {
    const parent = temporaryDirectory()
    chmodSync(parent, 0o500)
    const config = loadConfig({
      file: { logging: { file: { directory: join(parent, 'logs') } } },
      env: secrets,
    })
    const { lines, stream: terminal } = captureLog()
    const destination = createLogDestination({ config, stdout: terminal })
    const app = await buildServer({
      config,
      database: migratedDatabase(),
      logger: { level: 'info', stream: destination.stream },
    })

    const response = await app.inject({ method: 'GET', url: '/api/health' })
    await app.close()
    destination.close()
    chmodSync(parent, 0o700)

    expect(response.statusCode).toBe(200)
    expect(destination.path).toBeNull()
    const said = lines.join('')
    expect(said).toContain('Logging continues on stdout only')
    expect(said).toContain('"route":"/api/health"')
  })
})

/**
 * The destination writes two lines of its own, one about a stdout that has gone and one about a file
 * it could not open, and spec 14 criterion 2 says without exception that every line reaching the
 * file has been scrubbed. Both interpolate what the stream or the filesystem said, and an errno
 * message carries a path, so both go through the same function the stream applies.
 */
describe('the destination scrubs its own two lines too (spec 14 criterion 2)', () => {
  const directories: string[] = []

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      try {
        chmodSync(directory, 0o700)
      } catch {
        // Only the read-only case needs this, and only so the directory can be removed.
      }
      rmSync(directory, { recursive: true, force: true })
    }
  })

  function temporaryDirectory(): string {
    const created = mkdtempSync(join(tmpdir(), 'caroline-log-'))
    directories.push(created)
    return created
  }

  it('redacts a secret in what the failing stdout said, in the line it writes to the file', () => {
    const directory = temporaryDirectory()
    const config = loadConfig({ file: { logging: { file: { directory } } }, env: secrets })
    const closedTerminal = new Writable({
      write() {
        // An upstream message that happens to carry a configured secret. This is the shape the
        // scrubber exists for: the destination interpolates whatever it was told.
        throw new Error('EPIPE writing to ghp_supersecret')
      },
    })
    const destination = createLogDestination({ config, stdout: closedTerminal })

    destination.stream.write('{"msg":"a line"}\n')
    destination.close()

    const contents = readFileSync(join(directory, LOG_FILE_NAME), 'utf8')
    expect(contents).toContain('no longer write log lines to stdout')
    expect(contents).not.toContain('ghp_supersecret')
    expect(contents).toContain('[redacted]')
  })

  it('redacts a secret in the path it says it could not open, on stdout', () => {
    const parent = temporaryDirectory()
    // A path can hold anything, and the errno message names the path. Nothing stops somebody
    // configuring a directory whose name is also a value the redactor knows.
    const directory = join(parent, 'ghp_supersecret')
    chmodSync(parent, 0o500)
    const config = loadConfig({ file: { logging: { file: { directory } } }, env: secrets })
    const { lines, stream: terminal } = captureLog()

    const destination = createLogDestination({ config, stdout: terminal })
    destination.close()

    const said = lines.join('')
    expect(said).toContain('Logging continues on stdout only')
    expect(said).not.toContain('ghp_supersecret')
    expect(said).toContain('[redacted]')
  })

  /*
   * `EPIPE` on a pipe whose reader has gone arrives as an `error` event rather than as a throw, so
   * the listener is a second path into the same disabling and not a duplicate of the `try`. It is
   * also the worst failure this change could introduce: an unhandled `error` on stdout takes the
   * process down, which would be a crash caused by logging.
   */
  it('disables stdout on an error event, and keeps writing the file', () => {
    const directory = temporaryDirectory()
    const config = loadConfig({ file: { logging: { file: { directory } } }, env: secrets })
    const { lines, stream: terminal } = captureLog()
    const destination = createLogDestination({ config, stdout: terminal })

    destination.stream.write('{"msg":"before the error event"}\n')
    terminal.emit('error', new Error('EPIPE: broken pipe'))
    destination.stream.write('{"msg":"after the error event"}\n')
    destination.close()

    const contents = readFileSync(join(directory, LOG_FILE_NAME), 'utf8')
    expect(contents).toContain('before the error event')
    expect(contents).toContain('after the error event')
    expect(contents.match(/no longer write log lines to stdout/g)).toHaveLength(1)
    // Stdout stopped at the point it said it had gone, rather than being written to again.
    expect(lines.join('')).toBe('{"msg":"before the error event"}\n')
  })
})

/**
 * The bridge between the jobs, which are built first, and the logger, which the server owns. Spec
 * 14: anything logged before `attach` goes nowhere rather than throwing, and everything after it
 * reaches the target at the level it was written at.
 */
describe('the deferred log handle (spec 14)', () => {
  it('swallows a line written before there is a logger', () => {
    const log = deferredLog()

    expect(() => {
      log.debug({ job: 'sync' }, 'built before the server')
    }).not.toThrow()
  })

  it('passes every level through to the logger it is attached to', () => {
    const log = deferredLog()
    const seen: Array<[string, Record<string, unknown>, string]> = []
    const record =
      (level: string) =>
      (fields: Record<string, unknown>, message: string): void => {
        seen.push([level, fields, message])
      }

    log.attach({
      trace: record('trace'),
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
    })

    log.trace({ a: 1 }, 'at trace')
    log.debug({ a: 2 }, 'at debug')
    log.info({ a: 3 }, 'at info')
    log.warn({ a: 4 }, 'at warn')
    log.error({ a: 5 }, 'at error')

    expect(seen).toEqual([
      ['trace', { a: 1 }, 'at trace'],
      ['debug', { a: 2 }, 'at debug'],
      ['info', { a: 3 }, 'at info'],
      ['warn', { a: 4 }, 'at warn'],
      ['error', { a: 5 }, 'at error'],
    ])
  })
})

/**
 * A logging call is inside a `catch` block, so it is handed whatever was thrown, which need not be
 * an `Error`. The serialiser redacts the message and the stack while they are still strings, and
 * `redactSecrets` splits a string: a value with no `message` made that a `TypeError` raised from
 * inside `log.warn`, out of the `catch` it was reporting. Spec 09 criterion 6.
 */
describe('a non-Error handed to the logger', () => {
  it('is logged with its own text redacted, rather than throwing out of the log call', async () => {
    const { lines, stream } = captureLog()
    const config = loadConfig({ file: null, env: secrets })
    const app = await buildServer({
      config,
      database: migratedDatabase(),
      logger: { level: 'info', stream },
    })

    expect(() => {
      app.log.warn({ err: 'the upstream rejected with ghp_supersecret' }, 'something failed')
    }).not.toThrow()
    // A rejection with no text at all, which is what `undefined` reaches the serialiser as.
    expect(() => {
      app.log.warn({ err: undefined }, 'something else failed')
    }).not.toThrow()
    await app.close()

    const logged = lines.join('')
    expect(logged).toContain('something failed')
    expect(logged).toContain('something else failed')
    expect(logged).not.toContain('ghp_supersecret')
    expect(logged).toContain('[redacted]')
  })
})

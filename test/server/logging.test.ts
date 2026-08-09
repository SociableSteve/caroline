import { describe, expect, it } from 'vitest'
import { Writable } from 'node:stream'
import { loadConfig } from '../../src/config/load.js'
import { buildServer } from '../../src/server/app.js'

const secrets = {
  ANTHROPIC_API_KEY: 'sk-ant-supersecret',
  GITHUB_TOKEN: 'ghp_supersecret',
  CAROLINE_ACCESS_TOKEN: 'access-supersecret',
} as NodeJS.ProcessEnv

function captureLog() {
  const lines: string[] = []
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk))
      callback()
    },
  })
  return { lines, stream }
}

describe('no secret reaches a log line (spec 09 criterion 6)', () => {
  it('keeps secrets out of request logging, even when one appears in the URL', async () => {
    const { lines, stream } = captureLog()
    const config = loadConfig({ file: null, env: secrets })
    const app = await buildServer({ config, logger: { level: 'info', stream } })

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
      env: { CAROLINE_ACCESS_TOKEN: secretWithReservedChars } as NodeJS.ProcessEnv,
    })
    const app = await buildServer({ config, logger: { level: 'info', stream } })

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
      env: { CAROLINE_ACCESS_TOKEN: secretWithReservedChars } as NodeJS.ProcessEnv,
    })
    const app = await buildServer({ config, logger: { level: 'info', stream } })

    await app.inject({ method: 'GET', url: '/api/health?token=access%2btoken%2fvalue' })
    await app.close()

    expect(lines.join('\n')).not.toContain('access%2btoken%2fvalue')
  })

  it('keeps secrets out of a logged error message', async () => {
    const { lines, stream } = captureLog()
    const config = loadConfig({ file: null, env: secrets })
    const app = await buildServer({ config, logger: { level: 'info', stream } })

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

/**
 * `GET /api/jobs` and `POST /api/jobs/:name/run`. The manual trigger takes the same path a
 * scheduled run will (spec 06), and the history is where a connector's failure surfaces
 * (spec 02, criterion 5).
 */
import { describe, expect, it } from 'vitest'
import { recordJobRun } from '../../src/db/repositories/job-runs.js'
import { createSyncRunner, type SyncRunner } from '../../src/jobs/sync.js'
import { migratedDatabase } from '../helpers/temp-database.js'
import { REQUEST_TIME, testServer } from '../helpers/test-server.js'

describe('GET /api/jobs', () => {
  it('is empty before anything has run', async () => {
    const { app } = await testServer()

    const response = await app.inject({ method: 'GET', url: '/api/jobs' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ runs: [] })
  })

  it('returns a failed run with its error message, most recent first', async () => {
    const { app, database } = await testServer()
    recordJobRun(database, {
      job: 'sync:github',
      trigger: 'scheduled',
      startedAt: REQUEST_TIME - 900_000,
      finishedAt: REQUEST_TIME - 899_000,
      status: 'success',
      counts: { itemsSeen: 2 },
    })
    recordJobRun(database, {
      job: 'sync:github',
      trigger: 'manual',
      startedAt: REQUEST_TIME,
      finishedAt: REQUEST_TIME + 500,
      status: 'failure',
      error: 'GitHub answered 401 Unauthorized',
    })

    const { runs } = (await app.inject({ method: 'GET', url: '/api/jobs' })).json()

    expect(runs).toMatchObject([
      { status: 'failure', trigger: 'manual', error: 'GitHub answered 401 Unauthorized' },
      { status: 'success', counts: { itemsSeen: 2 } },
    ])
  })

  it('never returns the stack, which is of no use in a browser', async () => {
    const { app, database } = await testServer()
    recordJobRun(database, {
      job: 'sync:github',
      trigger: 'scheduled',
      startedAt: REQUEST_TIME,
      finishedAt: REQUEST_TIME,
      status: 'failure',
      error: 'nope',
      errorStack: 'Error: nope\n  at /home/someone/caroline/src/connectors/github.ts',
    })

    const body = (await app.inject({ method: 'GET', url: '/api/jobs' })).body

    expect(body).not.toContain('errorStack')
    expect(body).not.toContain('/home/someone')
  })

  it('filters by job name', async () => {
    const { app, database } = await testServer()
    for (const job of ['sync:github', 'sync:gmail']) {
      recordJobRun(database, {
        job,
        trigger: 'scheduled',
        startedAt: REQUEST_TIME,
        finishedAt: REQUEST_TIME,
        status: 'success',
      })
    }

    const { runs } = (await app.inject({ method: 'GET', url: '/api/jobs?job=sync:gmail' })).json()

    expect(runs).toMatchObject([{ job: 'sync:gmail' }])
  })

  it('rejects a limit outside the allowed range in the standard error shape', async () => {
    const { app } = await testServer()

    const response = await app.inject({ method: 'GET', url: '/api/jobs?limit=0' })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: { code: 'bad_request' } })
  })
})

describe('POST /api/jobs/:name/run', () => {
  it('runs sync and reports what each connector did', async () => {
    const { app } = await testServer()

    const response = await app.inject({ method: 'POST', url: '/api/jobs/sync/run' })

    expect(response.statusCode).toBe(200)
    // No credentials in a test config, so the connector is skipped rather than failed.
    expect(response.json()).toMatchObject({
      job: 'sync',
      results: [{ provider: 'github', status: 'skipped' }],
    })

    const { runs } = (await app.inject({ method: 'GET', url: '/api/jobs' })).json()
    expect(runs).toMatchObject([{ job: 'sync:github', trigger: 'manual', status: 'skipped' }])
  })

  it('is a 404 for a job that does not exist', async () => {
    const { app } = await testServer()

    const response = await app.inject({ method: 'POST', url: '/api/jobs/classify/run' })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({ error: { code: 'not_found' } })
  })

  it('answers a second trigger while one is in flight rather than queueing another', async () => {
    let release: () => void = () => {}
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let reportStarted: () => void = () => {}
    // The connector says when it has actually begun, so the second request is fired against a
    // run that is genuinely in flight rather than against whichever promise settled first.
    const started = new Promise<void>((resolve) => {
      reportStarted = resolve
    })

    const runner: SyncRunner = createSyncRunner({
      database: migratedDatabase(),
      connectors: [
        {
          provider: 'github',
          isConfigured: () => true,
          // eslint-disable-next-line require-yield -- it holds the run open, it does not feed it.
          async *fetch() {
            reportStarted()
            await blocked
          },
        },
      ],
      now: () => REQUEST_TIME,
    })

    const { app } = await testServer({ sync: runner })
    const first = app.inject({ method: 'POST', url: '/api/jobs/sync/run' })
    await started

    const second = await app.inject({ method: 'POST', url: '/api/jobs/sync/run' })

    expect(second.statusCode).toBe(409)
    expect(second.json()).toMatchObject({ error: { code: 'already_running' } })

    release()
    expect((await first).statusCode).toBe(200)
    expect(runner.isRunning()).toBe(false)
  })
})

/**
 * Shutdown closes the database. A run still applying items to a closed handle turns an
 * orderly stop into a stack trace and a half-applied pass, so it is waited for first.
 */
describe('draining a sync in flight', () => {
  function blockingRunner() {
    let release: () => void = () => {}
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let reportStarted: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      reportStarted = resolve
    })

    const runner = createSyncRunner({
      database: migratedDatabase(),
      connectors: [
        {
          provider: 'github',
          isConfigured: () => true,
          // eslint-disable-next-line require-yield -- it holds the run open, it does not feed it.
          async *fetch() {
            reportStarted()
            await blocked
          },
        },
      ],
      now: () => REQUEST_TIME,
    })

    return { runner, release, started }
  }

  it('returns at once when nothing is running', async () => {
    const runner = createSyncRunner({
      database: migratedDatabase(),
      connectors: [],
      now: () => REQUEST_TIME,
    })

    await expect(runner.drain()).resolves.toBeUndefined()
  })

  it('waits for the run to finish', async () => {
    const { runner, release, started } = blockingRunner()
    const run = runner.run('startup')
    await started

    let drained = false
    const draining = runner.drain().then(() => {
      drained = true
    })

    expect(drained).toBe(false)
    release()
    await draining
    await run

    expect(runner.isRunning()).toBe(false)
  })

  it('gives up after the timeout rather than refusing to shut down', async () => {
    const { runner, release, started } = blockingRunner()
    const run = runner.run('startup')
    await started

    await runner.drain(5)

    // Still going: the point is that waiting ended, not that the run did.
    expect(runner.isRunning()).toBe(true)
    release()
    await run
  })
})

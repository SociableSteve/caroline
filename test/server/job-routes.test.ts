/**
 * `GET /api/jobs`, `GET /api/jobs/status` and `POST /api/jobs/:name/run`. The manual trigger takes
 * the same path a scheduled run does (spec 06), and the history is where a connector's failure
 * surfaces (spec 02, criterion 5).
 */
import { describe, expect, it } from 'vitest'
import { recordJobRun } from '../../src/db/repositories/job-runs.js'
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

describe('GET /api/jobs/status', () => {
  it('names every scheduled job, its schedule and when it next runs', async () => {
    const { app } = await testServer()

    const { jobs } = (await app.inject({ method: 'GET', url: '/api/jobs/status' })).json()

    expect(jobs.map((job: { job: string }) => job.job)).toEqual([
      'sync',
      'classify',
      'plan',
      'purge',
    ])
    expect(jobs[0]).toMatchObject({
      cron: '*/15 * * * *',
      running: false,
      consecutiveFailures: 0,
      backoffUntil: null,
    })
    expect(jobs[0].nextRunAt).toBeGreaterThan(0)
  })

  it('reports the last run and the failure streak', async () => {
    const { app, database } = await testServer()
    recordJobRun(database, {
      job: 'classify',
      trigger: 'scheduled',
      startedAt: REQUEST_TIME,
      finishedAt: REQUEST_TIME + 100,
      status: 'failure',
      error: 'the provider is down',
    })

    const { jobs } = (await app.inject({ method: 'GET', url: '/api/jobs/status' })).json()
    const classify = jobs.find((job: { job: string }) => job.job === 'classify')

    expect(classify).toMatchObject({
      consecutiveFailures: 1,
      lastRun: { status: 'failure', error: 'the provider is down' },
    })
  })
})

describe('POST /api/jobs/:name/run', () => {
  it('runs sync and answers with the row it wrote', async () => {
    const { app } = await testServer()

    const response = await app.inject({ method: 'POST', url: '/api/jobs/sync/run' })

    expect(response.statusCode).toBe(200)
    // No credentials in a test config, so every connector is skipped rather than failed.
    expect(response.json()).toMatchObject({
      job: 'sync',
      run: { job: 'sync', trigger: 'manual', status: 'skipped' },
    })

    const { runs } = (await app.inject({ method: 'GET', url: '/api/jobs' })).json()
    // The calendar is part of the sync pass and writes its own row, alongside the two
    // connectors that produce sources. Spec 02.
    expect(runs.map((run: { job: string }) => run.job).sort()).toEqual([
      'sync',
      'sync:gcal',
      'sync:github',
      'sync:gmail',
    ])
  })

  it('runs classify, which is skipped with no provider configured', async () => {
    const { app } = await testServer()

    const response = await app.inject({ method: 'POST', url: '/api/jobs/classify/run' })

    expect(response.json()).toMatchObject({
      run: { job: 'classify', status: 'skipped', error: expect.stringMatching(/No LLM provider/) },
    })
  })

  it('runs purge', async () => {
    const { app } = await testServer()

    const response = await app.inject({ method: 'POST', url: '/api/jobs/purge/run' })

    expect(response.json()).toMatchObject({ run: { job: 'purge', status: 'success' } })
  })

  it('runs plan, which is skipped with no provider configured', async () => {
    const { app } = await testServer()

    const response = await app.inject({ method: 'POST', url: '/api/jobs/plan/run' })

    expect(response.json()).toMatchObject({
      run: { job: 'plan', status: 'skipped', error: expect.stringMatching(/No LLM provider/) },
    })
  })

  it('is a 404 for a job that does not exist', async () => {
    const { app } = await testServer()

    const response = await app.inject({ method: 'POST', url: '/api/jobs/reticulate/run' })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({ error: { code: 'not_found' } })
  })

  /** Spec 06, criterion 6. */
  it('answers a second trigger while one is in flight rather than queueing another', async () => {
    let release: () => void = () => {}
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let reportStarted: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      reportStarted = resolve
    })

    const { app, jobs } = await testServer({
      steps: [
        {
          name: 'sync',
          run: async () => {
            reportStarted()
            await blocked
            return { status: 'success' }
          },
        },
      ],
    })

    const first = app.inject({ method: 'POST', url: '/api/jobs/sync/run' })
    await started

    const second = await app.inject({ method: 'POST', url: '/api/jobs/sync/run' })

    expect(second.statusCode).toBe(409)
    expect(second.json()).toMatchObject({ error: { code: 'already_running' } })

    release()
    expect((await first).statusCode).toBe(200)
    expect(jobs.scheduler.isRunning('sync')).toBe(false)
  })

  it('announces the run so an open tab reloads', async () => {
    const { app, published } = await testServer()

    await app.inject({ method: 'POST', url: '/api/jobs/purge/run' })

    expect(published.map((event) => event.kind)).toContain('jobs')
  })
})

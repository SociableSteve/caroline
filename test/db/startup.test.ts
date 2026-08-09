import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config/load.js'
import { openCarolineDatabase } from '../../src/db/index.js'
import { createTask, getTask } from '../../src/db/repositories/tasks.js'
import { buildServer } from '../../src/server/app.js'
import { temporaryDatabasePath } from '../helpers/temp-database.js'

function configFor(path: string) {
  return loadConfig({ file: { database: { path } }, env: {} as NodeJS.ProcessEnv })
}

describe('opening the database at startup', () => {
  it('creates the file and migrates it in one step', () => {
    const path = temporaryDatabasePath()

    const database = openCarolineDatabase(configFor(path))
    try {
      expect(existsSync(path)).toBe(true)
      expect(() => createTask(database, { title: 'Book the venue' }, 0)).not.toThrow()
    } finally {
      database.close()
    }
  })

  it('creates the parent directory, so a first run needs no setup', () => {
    const path = join(temporaryDatabasePath(), '..', 'nested', 'caroline.db')

    const database = openCarolineDatabase(configFor(path))
    database.close()

    expect(existsSync(path)).toBe(true)
  })

  // Overview criterion 3: deleting the file and restarting gives a working empty system.
  it('reopens an existing database without touching the data in it', () => {
    const path = temporaryDatabasePath()
    const first = openCarolineDatabase(configFor(path))
    const task = createTask(first, { title: 'Book the venue' }, 0)
    first.close()

    const second = openCarolineDatabase(configFor(path))
    try {
      expect(getTask(second, task.id)?.title).toBe('Book the venue')
    } finally {
      second.close()
    }
  })
})

describe('GET /api/health with a database', () => {
  it('reports the database as ready once migrations have run', async () => {
    const path = temporaryDatabasePath()
    const config = configFor(path)
    const database = openCarolineDatabase(config)
    const app = await buildServer({ config, database })

    const body = (await app.inject({ method: 'GET', url: '/api/health' })).json()

    expect(body.database).toEqual({ status: 'ready' })
    await app.close()
    database.close()
  })

  it('omits the database entirely when the server was built without one', async () => {
    const app = await buildServer({
      config: loadConfig({ file: null, env: {} as NodeJS.ProcessEnv }),
    })

    const body = (await app.inject({ method: 'GET', url: '/api/health' })).json()

    expect(body.database).toBeUndefined()
    await app.close()
  })
})

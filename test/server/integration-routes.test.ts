/**
 * Connecting the Google account from Settings. Spec 09: the flow starts and finishes on this
 * server, and nothing from the callback's query string is echoed back.
 */
import { describe, expect, it } from 'vitest'
import type { GoogleAuth } from '../../src/connectors/google/auth.js'
import { GoogleAuthError } from '../../src/connectors/google/oauth.js'
import {
  countCalendarEvents,
  upsertCalendarEvent,
} from '../../src/db/repositories/calendar-events.js'
import { createTask, listTasks } from '../../src/db/repositories/tasks.js'
import { migratedDatabase } from '../helpers/temp-database.js'
import { REQUEST_TIME, testServer } from '../helpers/test-server.js'

const CONNECT_URL =
  'https://accounts.google.com/o/oauth2/v2/auth?client_id=client-123&state=state-1'

interface FakeAuthOptions {
  readonly connected?: boolean
  readonly beginThrows?: Error
  readonly completeThrows?: Error
}

/** A Google connection whose calls are recorded, so the routes can be tested on their own. */
function fakeGoogle({ connected = false, beginThrows, completeThrows }: FakeAuthOptions = {}) {
  const completed: Array<{ code: string; state: string }> = []
  let disconnected = false

  const auth: GoogleAuth = {
    isConnected: () => connected,
    status: () => ({
      connected,
      connectedAt: connected ? 1_780_000_000_000 : null,
      scopes: connected ? ['https://www.googleapis.com/auth/gmail.readonly'] : [],
      configured: true,
    }),
    accessToken: () => Promise.resolve('access-1'),
    begin: () => {
      if (beginThrows !== undefined) throw beginThrows
      return { url: CONNECT_URL, state: 'state-1' }
    },
    complete: async (code, state) => {
      if (completeThrows !== undefined) throw completeThrows
      completed.push({ code, state })
    },
    disconnect: () => {
      disconnected = true
      return true
    },
  }

  return {
    auth,
    completed,
    get disconnected() {
      return disconnected
    },
  }
}

describe('GET /api/integrations/google', () => {
  it('says it is not connected on a clean checkout, and where to send the browser back to', async () => {
    const { app } = await testServer()

    const response = await app.inject({ method: 'GET', url: '/api/integrations/google' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      connected: false,
      configured: false,
      connectedAt: null,
      scopes: [],
      redirectUri: 'http://127.0.0.1:5123/api/integrations/google/callback',
    })
  })

  it('reports a connection with the scopes it was granted, and no token', async () => {
    const google = fakeGoogle({ connected: true })
    const { app } = await testServer({ google: google.auth })

    const response = await app.inject({ method: 'GET', url: '/api/integrations/google' })

    expect(response.json()).toMatchObject({
      connected: true,
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    })
    expect(response.body).not.toContain('access')
    expect(response.body).not.toContain('refresh')
  })
})

describe('POST /api/integrations/google/connect', () => {
  it('answers with the URL to open', async () => {
    const google = fakeGoogle()
    const { app } = await testServer({ google: google.auth })

    const response = await app.inject({ method: 'POST', url: '/api/integrations/google/connect' })

    expect(response.json()).toEqual({ url: CONNECT_URL })
  })

  it('says what is missing when there is nothing to consent to yet', async () => {
    const google = fakeGoogle({ beginThrows: new GoogleAuthError('Google is not configured.') })
    const { app } = await testServer({ google: google.auth })

    const response = await app.inject({ method: 'POST', url: '/api/integrations/google/connect' })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: { code: 'not_configured' } })
  })
})

describe('GET /api/integrations/google/callback', () => {
  it('completes the flow and sends the browser back to Settings', async () => {
    const google = fakeGoogle()
    const { app } = await testServer({ google: google.auth })

    const response = await app.inject({
      method: 'GET',
      url: '/api/integrations/google/callback?code=code-1&state=state-1',
    })

    expect(response.statusCode).toBe(302)
    expect(response.headers.location).toBe('/#/settings?google=connected')
    expect(google.completed).toEqual([{ code: 'code-1', state: 'state-1' }])
  })

  it('never echoes the code back, whatever happens', async () => {
    const google = fakeGoogle({ completeThrows: new GoogleAuthError('nope') })
    const { app } = await testServer({ google: google.auth })

    const response = await app.inject({
      method: 'GET',
      url: '/api/integrations/google/callback?code=secret-code&state=state-1',
    })

    expect(response.statusCode).toBe(302)
    expect(response.headers.location).toBe('/#/settings?google=failed')
    expect(response.body).not.toContain('secret-code')
  })

  it('passes Google’s refusal along without inventing one', async () => {
    const google = fakeGoogle()
    const { app } = await testServer({ google: google.auth })

    const response = await app.inject({
      method: 'GET',
      url: '/api/integrations/google/callback?error=access_denied',
    })

    expect(response.headers.location).toBe('/#/settings?google=refused&reason=access_denied')
    expect(google.completed).toEqual([])
  })

  it('says so when the callback carries neither a code nor an error', async () => {
    const google = fakeGoogle()
    const { app } = await testServer({ google: google.auth })

    const response = await app.inject({
      method: 'GET',
      url: '/api/integrations/google/callback',
    })

    expect(response.headers.location).toBe('/#/settings?google=incomplete')
  })

  /** Google adds fields of its own to the callback, and a request carrying them is not a bad one. */
  it('ignores the extra parameters Google appends', async () => {
    const google = fakeGoogle()
    const { app } = await testServer({ google: google.auth })

    const response = await app.inject({
      method: 'GET',
      url: '/api/integrations/google/callback?code=code-1&state=state-1&scope=a+b&authuser=0&prompt=consent',
    })

    expect(response.statusCode).toBe(302)
    expect(google.completed).toHaveLength(1)
  })
})

describe('DELETE /api/integrations/google', () => {
  it('forgets the connection', async () => {
    const google = fakeGoogle({ connected: true })
    const { app } = await testServer({ google: google.auth })

    const response = await app.inject({ method: 'DELETE', url: '/api/integrations/google' })

    expect(response.statusCode).toBe(204)
    expect(google.disconnected).toBe(true)
  })

  /**
   * A calendar event is a reading of a calendar rather than something Caroline was asked to
   * remember. Left behind, it would go on reducing tomorrow's capacity for a meeting nobody can
   * check. Spec 09.
   */
  it('takes the diary with it', async () => {
    const database = migratedDatabase()
    upsertCalendarEvent(
      database,
      {
        calendarId: 'primary',
        externalId: 'event-1',
        summary: 'Hub weekly',
        startsAt: REQUEST_TIME,
        endsAt: REQUEST_TIME + 60 * 60_000,
        allDay: false,
        responseStatus: 'accepted',
        transparency: 'opaque',
        status: 'confirmed',
        attendeeCount: 2,
        url: null,
      },
      REQUEST_TIME,
    )
    const { app } = await testServer({ database, google: fakeGoogle({ connected: true }).auth })

    await app.inject({ method: 'DELETE', url: '/api/integrations/google' })

    expect(countCalendarEvents(database)).toBe(0)
  })

  /** The work Gmail and GitHub produced is work, not a reading, and it stays. */
  it('leaves the tasks alone', async () => {
    const database = migratedDatabase()
    createTask(database, { title: 'Hub numbers', status: 'inbox' }, REQUEST_TIME)
    const { app } = await testServer({ database, google: fakeGoogle({ connected: true }).auth })

    await app.inject({ method: 'DELETE', url: '/api/integrations/google' })

    expect(listTasks(database, {}, REQUEST_TIME).total).toBe(1)
  })
})

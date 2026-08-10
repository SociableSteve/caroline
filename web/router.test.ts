import { describe, expect, it } from 'vitest'
import { parseRoute, projectHref } from './router.js'

describe('parseRoute', () => {
  it('lands on the dashboard for an empty hash', () => {
    expect(parseRoute('')).toEqual({ name: 'dashboard' })
    expect(parseRoute('#/')).toEqual({ name: 'dashboard' })
  })

  it('reads the board and the projects list', () => {
    expect(parseRoute('#/board')).toEqual({ name: 'board' })
    expect(parseRoute('#/projects')).toEqual({ name: 'projects' })
  })

  it('reads the jobs and settings surfaces', () => {
    expect(parseRoute('#/jobs')).toEqual({ name: 'jobs' })
    expect(parseRoute('#/settings')).toEqual({ name: 'settings', outcome: null })
  })

  /** The Google callback redirects here with how it went, and Settings says so. Spec 09. */
  it('reads the outcome the OAuth callback left on the settings route', () => {
    expect(parseRoute('#/settings?google=connected')).toEqual({
      name: 'settings',
      outcome: 'connected',
    })
  })

  it('reads a project drill-in, decoding the id', () => {
    expect(parseRoute('#/projects/project%201')).toEqual({ name: 'project', id: 'project 1' })
  })

  it('ignores a query string, so a link with one still routes', () => {
    expect(parseRoute('#/board?focus=task-1')).toEqual({ name: 'board' })
  })

  it('falls back to the dashboard rather than rendering nothing', () => {
    expect(parseRoute('#/nowhere')).toEqual({ name: 'dashboard' })
  })

  /** A malformed escape used to throw out of the router, which took the app down with it. */
  it('falls back to the dashboard for an id that cannot be decoded', () => {
    expect(parseRoute('#/projects/%')).toEqual({ name: 'dashboard' })
    expect(parseRoute('#/projects/%E0%A4%A')).toEqual({ name: 'dashboard' })
  })

  it('round-trips an id that needs escaping', () => {
    const id = 'a/b c'

    expect(parseRoute(projectHref(id))).toEqual({ name: 'project', id })
  })
})

import { describe, expect, it } from 'vitest'
import {
  chatRailHref,
  conversationHref,
  parseLocation,
  parseRoute,
  projectHref,
  surfaceHref,
} from './router.js'

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

  /**
   * Chat is no longer a route. It is a rail beside whichever surface is showing (spec 08), so
   * `#/chat` names nothing and gets the same fallback as any other unrecognised hash.
   */
  it('no longer knows a chat surface', () => {
    expect(parseRoute('#/chat')).toEqual({ name: 'dashboard' })
    expect(parseRoute('#/chat/conversation-1')).toEqual({ name: 'dashboard' })
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

/**
 * The conversation open beside the surface. Spec 08: the rail is a companion rather than a route, and
 * the conversation still has a URL, because a conversation you cannot link to is one you cannot come
 * back to.
 */
describe('the conversation beside the surface', () => {
  it('is nothing until a hash names one', () => {
    expect(parseLocation('#/board')).toMatchObject({
      route: { name: 'board' },
      conversationId: null,
    })
  })

  it('is read off whichever surface is showing', () => {
    expect(parseLocation('#/board?conversation=abc')).toMatchObject({
      route: { name: 'board' },
      conversationId: 'abc',
    })
    expect(parseLocation('#/?conversation=abc')).toMatchObject({
      route: { name: 'dashboard' },
      conversationId: 'abc',
    })
  })

  /** What an empty parameter means: the rail is open on a conversation nobody has started yet. */
  it('treats an empty parameter as a new conversation rather than an empty id', () => {
    expect(parseLocation('#/board?conversation=')).toMatchObject({ conversationId: null })
  })

  it('keeps the surface when a conversation is opened, and the parameters with it', () => {
    expect(conversationHref('abc', '#/board')).toBe('#/board?conversation=abc')
    expect(conversationHref('abc', '#/settings?google=connected')).toBe(
      '#/settings?google=connected&conversation=abc',
    )
  })

  it('keeps the surface when the conversation is closed', () => {
    expect(conversationHref(null, '#/board?conversation=abc')).toBe('#/board')
    expect(conversationHref(null, '#/settings?google=connected&conversation=abc')).toBe(
      '#/settings?google=connected',
    )
  })

  /**
   * A hash the app never writes but a hand-edited or stale link can carry: a conversation to read
   * and a closed rail at once. The conversation wins when it is read, so both links this function
   * builds have to agree with that and clear the close rather than leave one behind that would shut
   * the rail on the next click.
   */
  it('clears a contradicting close, whether it names a conversation or none', () => {
    expect(conversationHref('two', '#/board?conversation=one&chat=closed')).toBe(
      '#/board?conversation=two',
    )
    expect(conversationHref(null, '#/board?conversation=one&chat=closed')).toBe('#/board')
    expect(
      parseLocation(conversationHref(null, '#/board?conversation=one&chat=closed')),
    ).toMatchObject({ chatOpen: true, conversationId: null })
  })

  it('lands on the dashboard rather than a bare hash where there is no path', () => {
    expect(conversationHref('abc', '')).toBe('#/?conversation=abc')
  })

  it('round-trips an id that needs escaping', () => {
    const id = 'a/b c'

    expect(parseLocation(conversationHref(id, '#/board'))).toMatchObject({
      route: { name: 'board' },
      conversationId: id,
    })
  })

  /** Replaces rather than appends: opening a second conversation is not opening two. */
  it('replaces the conversation already in the hash', () => {
    expect(conversationHref('two', '#/board?conversation=one')).toBe('#/board?conversation=two')
  })
})

/**
 * The rail's openness lives in the hash too, so a reload, a back button and a shared link agree
 * about it. Open is the default, so it is closing that the hash records.
 */
describe('whether the rail is open', () => {
  it('is open until the hash says it was closed', () => {
    expect(parseLocation('#/board')).toMatchObject({ chatOpen: true, conversationId: null })
    expect(parseLocation('')).toMatchObject({ chatOpen: true })
  })

  it('is closed for the hash a close writes', () => {
    expect(parseLocation('#/board?chat=closed')).toMatchObject({
      chatOpen: false,
      conversationId: null,
    })
  })

  /** Links written before open was the default still mean what they said. */
  it('is open for an empty parameter and for a named conversation alike', () => {
    expect(parseLocation('#/board?conversation=')).toMatchObject({
      chatOpen: true,
      conversationId: null,
    })
    expect(parseLocation('#/board?conversation=abc')).toMatchObject({
      chatOpen: true,
      conversationId: 'abc',
    })
  })

  it('opens and closes without leaving the surface', () => {
    expect(chatRailHref(false, '#/board')).toBe('#/board?chat=closed')
    expect(chatRailHref(true, '#/board?chat=closed')).toBe('#/board')
  })

  /** Opening is the default, so it is written as the absence of the parameter rather than as one. */
  it('says nothing in the hash for the state that is the default', () => {
    expect(chatRailHref(true, '#/board')).toBe('#/board')
    expect(chatRailHref(true, '#/board?conversation=abc')).toBe('#/board?conversation=abc')
  })

  /** Closing takes the conversation with it: a hash naming one nobody can see would reopen it. */
  it('drops the conversation when it closes', () => {
    expect(chatRailHref(false, '#/board?conversation=abc')).toBe('#/board?chat=closed')
    expect(parseLocation(chatRailHref(false, '#/board?conversation=abc'))).toMatchObject({
      chatOpen: false,
      conversationId: null,
    })
  })

  it('keeps the surface parameters it was not asked about', () => {
    expect(chatRailHref(false, '#/settings?google=connected')).toBe(
      '#/settings?google=connected&chat=closed',
    )
  })
})

/**
 * A surface link. The rail is a companion to whichever surface is showing, so changing surface is
 * not closing it: the two parameters that say what the rail is doing travel to the new surface, and
 * the parameters that belonged to the old one do not.
 */
describe('surfaceHref', () => {
  it('carries the open conversation to the new surface', () => {
    expect(surfaceHref('#/projects', '#/board?conversation=abc')).toBe(
      '#/projects?conversation=abc',
    )
  })

  it('carries a closed rail to the new surface, so navigating does not reopen it', () => {
    expect(surfaceHref('#/projects', '#/board?chat=closed')).toBe('#/projects?chat=closed')
  })

  it('leaves the parameters that belonged to the surface being left behind', () => {
    expect(surfaceHref('#/board', '#/settings?google=connected&conversation=abc')).toBe(
      '#/board?conversation=abc',
    )
  })

  it('is the plain link where there is nothing to carry', () => {
    expect(surfaceHref('#/board', '#/projects')).toBe('#/board')
    expect(surfaceHref('#/', '')).toBe('#/')
  })
})

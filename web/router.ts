/**
 * Hash routing, in about as much code as it takes to describe it. Five surfaces and a drill-in do
 * not need a router library, and the hash keeps the server out of it: any URL still loads the same
 * shell, so a reload lands where you were.
 *
 * A conversation is not one of the surfaces. Chat is a rail beside whichever surface you are on
 * (spec 08), so the conversation being read is a parameter of the location rather than a route of
 * its own: `#/board?conversation=abc` is the board, with that conversation open beside it. It still
 * has a URL, because a conversation you cannot link to is one you cannot come back to.
 */
import { useEffect, useState } from 'react'

export type Route =
  | { readonly name: 'dashboard' }
  | { readonly name: 'board' }
  | { readonly name: 'projects' }
  | { readonly name: 'project'; readonly id: string }
  | { readonly name: 'jobs' }
  /** `outcome` is what the Google callback left in the hash, so Settings can say how it went. */
  | { readonly name: 'settings'; readonly outcome: string | null }

/** The surface, and the conversation open beside it. Spec 08's five and a companion. */
export interface AppLocation {
  readonly route: Route
  /**
   * Whether the URL asks for the rail. Its openness lives in the hash rather than only in a
   * component, so that a reload, a back button and a shared link all agree about it. Open is the
   * default, so what the hash records is a close: `?chat=closed`. An empty `?conversation=` is the
   * rail open on a conversation nobody has started yet, which is what a link written before open
   * was the default says.
   */
  readonly chatOpen: boolean
  /** The conversation the rail is reading, or null for a new one. */
  readonly conversationId: string | null
  /**
   * The hash as it stands, so that a link which opens a conversation can keep the surface and the
   * parameters it was built from rather than reading the address bar behind React's back.
   */
  readonly hash: string
}

export const routeLinks = [
  { href: '#/', label: 'Dashboard', name: 'dashboard' },
  { href: '#/board', label: 'Board', name: 'board' },
  { href: '#/projects', label: 'Projects', name: 'projects' },
  { href: '#/jobs', label: 'Jobs', name: 'jobs' },
  { href: '#/settings', label: 'Settings', name: 'settings' },
] as const

/** The query parameter the open conversation travels in, on whichever surface is showing. */
const CONVERSATION_PARAM = 'conversation'

/**
 * The parameter a closed rail travels in, and its only value. Closing is what the hash records
 * rather than opening, because the rail is open by default and a URL should not have to say so.
 */
const CHAT_PARAM = 'chat'
const CHAT_CLOSED = 'closed'

/**
 * The parameters that describe the rail rather than the surface, and so follow a surface link
 * across. Everything else in a query belongs to the surface it was on: the settings outcome is
 * about the connect that just happened, and carrying it to the board would be nonsense.
 */
const RAIL_PARAMS: readonly string[] = [CONVERSATION_PARAM, CHAT_PARAM]

/** Anything unrecognised is the dashboard, which is the least surprising landing place. */
export function parseRoute(hash: string): Route {
  const [path = '', query = ''] = hash.replace(/^#\/?/, '').split('?')
  const segments = path.split('/').filter((segment) => segment.length > 0)

  if (segments[0] === 'board') return { name: 'board' }
  if (segments[0] === 'jobs') return { name: 'jobs' }
  if (segments[0] === 'settings') {
    // The OAuth callback redirects here with its outcome. It is one of a fixed set of words
    // Caroline itself chose, and the screen matches it against that set rather than showing it.
    return { name: 'settings', outcome: new URLSearchParams(query).get('google') }
  }
  if (segments[0] === 'projects') {
    const id = segments[1]
    if (id === undefined) return { name: 'projects' }

    const decoded = decode(id)
    // A hash such as `#/projects/%` is not a project id, and throwing out of the router would
    // take the whole app down. It is an unrecognised route, so it gets the same fallback.
    return decoded === null ? { name: 'dashboard' } : { name: 'project', id: decoded }
  }

  return { name: 'dashboard' }
}

/** The whole location: which surface, and which conversation is open beside it. */
export function parseLocation(hash: string): AppLocation {
  const [, query = ''] = hash.replace(/^#\/?/, '').split('?')
  const params = new URLSearchParams(query)
  const raw = params.get(CONVERSATION_PARAM)

  return {
    route: parseRoute(hash),
    hash,
    // Open unless the hash says it was closed. A hash naming a conversation is asking for the rail
    // either way, so it cannot be both.
    chatOpen: raw !== null || params.get(CHAT_PARAM) !== CHAT_CLOSED,
    // An empty parameter is a new conversation rather than a conversation with an empty id, which
    // is what `#/board?conversation=` means when the rail has just been opened.
    conversationId: raw === null || raw === '' ? null : raw,
  }
}

function decode(segment: string): string | null {
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

export function projectHref(id: string): string {
  return `#/projects/${encodeURIComponent(id)}`
}

/**
 * The current location with a conversation opened beside it, or with none. The surface is kept,
 * because opening a conversation is not leaving the surface you were asking about, and so are the
 * other parameters: the settings outcome is one of them.
 */
export function conversationHref(id: string | null, hash: string): string {
  const [path = '', query = ''] = hash.replace(/^#/, '').split('?')
  const params = new URLSearchParams(query)

  if (id === null) params.delete(CONVERSATION_PARAM)
  else {
    params.set(CONVERSATION_PARAM, id)
    // A conversation to read is the rail open, so a close left in the hash would contradict it.
    params.delete(CHAT_PARAM)
  }

  return withParams(path, params)
}

/**
 * The same location with the rail opened or closed. Only the close is written down: the rail is open
 * by default, so opening it is the absence of the parameter rather than a value of it, and a link
 * with nothing to say about chat is a link with the rail open beside the surface.
 *
 * Closing takes the conversation with it. A hash naming a conversation nobody can see would reopen
 * the rail on the next reload, which is not what closing it meant.
 */
export function chatRailHref(open: boolean, hash: string): string {
  const [path = '', query = ''] = hash.replace(/^#/, '').split('?')
  const params = new URLSearchParams(query)

  if (open) params.delete(CHAT_PARAM)
  else {
    params.delete(CONVERSATION_PARAM)
    params.set(CHAT_PARAM, CHAT_CLOSED)
  }

  return withParams(path, params)
}

/**
 * A link to another surface, keeping whatever the rail is doing. Chat is a companion to whichever
 * surface is showing (spec 08), so changing surface is not closing the rail and not leaving the
 * conversation behind either; without this, every surface link dropped both.
 */
export function surfaceHref(href: string, hash: string): string {
  const [path = ''] = href.replace(/^#/, '').split('?')
  const [, query = ''] = hash.replace(/^#/, '').split('?')
  const current = new URLSearchParams(query)
  const params = new URLSearchParams()

  for (const name of RAIL_PARAMS) {
    const value = current.get(name)
    if (value !== null) params.set(name, value)
  }

  return withParams(path, params)
}

/** A hash from a path and its parameters, landing on the dashboard where there is no path. */
function withParams(path: string, params: URLSearchParams): string {
  const rest = params.toString()
  return `#${path === '' ? '/' : path}${rest === '' ? '' : `?${rest}`}`
}

export function useLocation(): AppLocation {
  const [location, setLocation] = useState<AppLocation>(() => parseLocation(window.location.hash))

  useEffect(() => {
    const onChange = () => setLocation(parseLocation(window.location.hash))
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])

  return location
}

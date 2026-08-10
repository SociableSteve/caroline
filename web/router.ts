/**
 * Hash routing, in about as much code as it takes to describe it. Four surfaces and a
 * drill-in do not need a router library, and the hash keeps the server out of it: any URL
 * still loads the same shell, so a reload lands where you were.
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

export const routeLinks = [
  { href: '#/', label: 'Dashboard', name: 'dashboard' },
  { href: '#/board', label: 'Board', name: 'board' },
  { href: '#/projects', label: 'Projects', name: 'projects' },
  { href: '#/jobs', label: 'Jobs', name: 'jobs' },
  { href: '#/settings', label: 'Settings', name: 'settings' },
] as const

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

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash))

  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash))
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])

  return route
}

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

export const routeLinks = [
  { href: '#/', label: 'Dashboard', name: 'dashboard' },
  { href: '#/board', label: 'Board', name: 'board' },
  { href: '#/projects', label: 'Projects', name: 'projects' },
] as const

/** Anything unrecognised is the dashboard, which is the least surprising landing place. */
export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#\/?/, '').split('?')[0] ?? ''
  const segments = path.split('/').filter((segment) => segment.length > 0)

  if (segments[0] === 'board') return { name: 'board' }
  if (segments[0] === 'projects') {
    const id = segments[1]
    return id === undefined ? { name: 'projects' } : { name: 'project', id: decodeURIComponent(id) }
  }

  return { name: 'dashboard' }
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

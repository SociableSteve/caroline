/**
 * One heading outline per surface, and one title per surface. Spec 10 criteria 5 and 6.
 *
 * The client had exactly one `h1`, the word "Caroline" in the header, which left every surface's
 * outline headless and every entry in browser history identically labelled. Each surface now names
 * itself in both places, and calls this to do the second: it is the surface that knows its own
 * name, and the drill-in's name is the project's.
 */
import { useEffect } from 'react'

export const productName = 'Caroline'

export function surfaceTitle(name: string): string {
  return `${name} · ${productName}`
}

export function useSurfaceTitle(name: string): void {
  useEffect(() => {
    document.title = surfaceTitle(name)
  }, [name])
}

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const packageJsonPath = fileURLToPath(new URL('../../package.json', import.meta.url))

/** The running version, read from package.json. Reported by `/api/health`. */
export const version: string = (() => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
    const candidate = (parsed as { version?: unknown }).version
    return typeof candidate === 'string' ? candidate : '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

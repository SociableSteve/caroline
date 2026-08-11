/**
 * `caroline.config.example.json` is what the setup guide has people copy, and the file config
 * schema is strict: a stale key in it is a Caroline that will not start, reported against a file
 * the reader did not write. So it is loaded here rather than trusted, and it is checked against the
 * defaults rather than only for being valid: a documented example that quietly changes behaviour is
 * a worse example than none.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config/load.js'

const examplePath = fileURLToPath(
  new URL('../../caroline.config.example.json', import.meta.url).toString(),
)

const example = JSON.parse(readFileSync(examplePath, 'utf8')) as {
  jobs: { timezone: string }
}

const noEnvironment = {} as NodeJS.ProcessEnv

describe('caroline.config.example.json', () => {
  it('loads', () => {
    expect(() => loadConfig({ file: example, env: noEnvironment })).not.toThrow()
  })

  it('states the defaults, so copying it changes nothing but the timezone it has to name', () => {
    // The timezone default is whatever this machine thinks it is in, which is the right answer for
    // a single-user tool and the one thing an example file cannot state. It is therefore pinned on
    // both sides rather than excused.
    const defaults = loadConfig({
      file: { jobs: { timezone: example.jobs.timezone } },
      env: noEnvironment,
    })

    expect(loadConfig({ file: example, env: noEnvironment })).toEqual(defaults)
  })
})

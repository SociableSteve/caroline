/**
 * Spec 13, "Where the boundary decision is made": `authRequired` derived once, in one function,
 * from `server.host`, `server.publicUrl` and `auth.mode`. `src/config/load.ts` exercises this
 * through `loadConfig`; this file is about the rule in isolation.
 */
import { describe, expect, it } from 'vitest'
import { computeAuthRequired, isLoopbackHost } from '../../src/auth/boundary.js'

describe('isLoopbackHost', () => {
  it('accepts the documented loopback set', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1']) {
      expect(isLoopbackHost(host), host).toBe(true)
    }
  })

  it('rejects the wildcard binds, which accept connections from the network (criterion 5)', () => {
    expect(isLoopbackHost('0.0.0.0')).toBe(false)
    expect(isLoopbackHost('::')).toBe(false)
  })

  it('rejects a host that merely looks like loopback', () => {
    expect(isLoopbackHost('127.0.0.2')).toBe(false)
  })
})

describe('computeAuthRequired', () => {
  it('is false for a loopback bind, no public URL and auto (criterion 2)', () => {
    expect(computeAuthRequired({ host: '127.0.0.1', publicUrl: null, mode: 'auto' })).toBe(false)
  })

  it('is true once the bind is not loopback (rule 1)', () => {
    expect(computeAuthRequired({ host: '0.0.0.0', publicUrl: null, mode: 'auto' })).toBe(true)
    expect(computeAuthRequired({ host: '::', publicUrl: null, mode: 'auto' })).toBe(true)
  })

  it('is true once server.publicUrl is set, whatever the bind is (rule 2)', () => {
    expect(
      computeAuthRequired({
        host: '127.0.0.1',
        publicUrl: 'https://caroline.example.com',
        mode: 'auto',
      }),
    ).toBe(true)
  })

  it('is true on a loopback bind once auth.mode is required (rule 3)', () => {
    expect(computeAuthRequired({ host: '127.0.0.1', publicUrl: null, mode: 'required' })).toBe(true)
  })
})

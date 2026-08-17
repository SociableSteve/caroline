/**
 * Spec 12, criterion 35: the address a client metadata URL resolves to is checked before
 * anything connects to it. `isPublicAddress` is that check, in isolation from the fetch that
 * calls it.
 */
import { describe, expect, it } from 'vitest'
import { isPublicAddress } from '../../../src/mcp/oauth/address-guard.js'

describe('isPublicAddress', () => {
  it('accepts an ordinary public IPv4 address', () => {
    expect(isPublicAddress('93.184.216.34')).toBe(true)
  })

  it('accepts an ordinary public IPv6 address', () => {
    expect(isPublicAddress('2606:2800:220:1:248:1893:25c8:1946')).toBe(true)
  })

  it.each([
    ['loopback', '127.0.0.1'],
    ['link-local', '169.254.1.1'],
    ['RFC 1918 (10/8)', '10.0.0.1'],
    ['RFC 1918 (172.16/12)', '172.16.0.1'],
    ['RFC 1918 (192.168/16)', '192.168.1.1'],
    ['"this network"', '0.0.0.1'],
  ])('refuses an IPv4 %s address (%s)', (_label, address) => {
    expect(isPublicAddress(address)).toBe(false)
  })

  it.each([
    ['unspecified', '::'],
    ['loopback', '::1'],
    ['link-local', 'fe80::1'],
    ['unique-local', 'fc00::1'],
    ['unique-local (fd)', 'fd12:3456:789a::1'],
  ])('refuses an IPv6 %s address (%s)', (_label, address) => {
    expect(isPublicAddress(address)).toBe(false)
  })

  it('refuses the IPv4-mapped IPv6 form of a private address', () => {
    expect(isPublicAddress('::ffff:127.0.0.1')).toBe(false)
    expect(isPublicAddress('::ffff:10.0.0.1')).toBe(false)
    expect(isPublicAddress('::ffff:192.168.1.1')).toBe(false)
  })

  it('accepts the IPv4-mapped IPv6 form of a public address', () => {
    expect(isPublicAddress('::ffff:93.184.216.34')).toBe(true)
  })

  it('refuses the fully expanded IPv4-mapped IPv6 form of a private address', () => {
    expect(isPublicAddress('0:0:0:0:0:ffff:7f00:1')).toBe(false)
  })

  it('refuses an unparsable address rather than treating it as public', () => {
    expect(isPublicAddress('not-an-address')).toBe(false)
  })
})

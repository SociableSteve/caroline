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
    ['link-local (fea0, top of the /10)', 'fea0::1'],
    ['link-local (febf, top of the /10)', 'febf::1'],
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

  /**
   * The ranges the first version of this guard did not name. None of them is a routable public
   * destination, and each is somewhere a resolver can be made to point: the shared-address space
   * a carrier-grade NAT hands out reaches other customers of the same network, the benchmarking
   * range and the protocol assignment range reach devices on the local network, and a multicast
   * or broadcast address reaches whatever is listening on the segment the process is attached to.
   * Spec 12, criterion 35, extended rather than joined by a second criterion.
   */
  it.each([
    ['shared address space (100.64/10)', '100.64.0.1'],
    ['shared address space, top of the /10', '100.127.255.254'],
    ['IETF protocol assignments (192.0.0/24)', '192.0.0.1'],
    ['benchmarking (198.18/15)', '198.18.0.1'],
    ['benchmarking, second half of the /15', '198.19.0.1'],
    ['multicast (224/4)', '224.0.0.1'],
    ['multicast, top of the /4', '239.255.255.255'],
    ['broadcast', '255.255.255.255'],
  ])('refuses an IPv4 %s address (%s)', (_label, address) => {
    expect(isPublicAddress(address)).toBe(false)
  })

  it.each([
    ['multicast (ff00::/8)', 'ff00::1'],
    ['multicast, link-local scope', 'ff02::1'],
    ['NAT64 (64:ff9b::/96), wrapping a loopback address', '64:ff9b::7f00:1'],
    ['NAT64, wrapping an RFC 1918 address', '64:ff9b::a00:1'],
    ['NAT64, wrapping a public address', '64:ff9b::5db8:d822'],
  ])('refuses an IPv6 %s address (%s)', (_label, address) => {
    expect(isPublicAddress(address)).toBe(false)
  })

  /**
   * The two ranges the security review of 2026-08-21 found still open, of the same kind as the
   * ones above rather than a new kind. `240.0.0.0/4` is reserved and unrouted, so an answer in it
   * is a resolver saying something this process cannot act on meaningfully, and it is exactly the
   * sort of range a stack maps onto something local. `64:ff9b:1::/48` is RFC 8215's local-use
   * NAT64 prefix, which is the prefix a site actually deploys when it does not use the well-known
   * one, so covering only `64:ff9b::/96` covered the less likely half. Spec 12, criterion 35,
   * extended again rather than joined by a criterion of its own.
   */
  it.each([
    ['reserved (240/4)', '240.0.0.1'],
    ['reserved, middle of the /4', '250.1.2.3'],
    ['reserved, top of the /4 below the broadcast address', '255.255.255.254'],
  ])('refuses an IPv4 %s address (%s)', (_label, address) => {
    expect(isPublicAddress(address)).toBe(false)
  })

  it.each([
    ['local-use NAT64 (64:ff9b:1::/48), wrapping a loopback address', '64:ff9b:1::7f00:1'],
    ['local-use NAT64, with the whole prefix spelled out', '64:ff9b:1:0:0:0:5db8:d822'],
    ['local-use NAT64, another subnet of the /48', '64:ff9b:1:abcd::1'],
  ])('refuses an IPv6 %s address (%s)', (_label, address) => {
    expect(isPublicAddress(address)).toBe(false)
  })

  it('still accepts a public address that merely begins like the NAT64 prefix', () => {
    // `64:ff9b:2::/48` is outside both NAT64 prefixes, so a guard written as "anything under
    // 64:ff9b" would be refusing something these criteria do not name. The point of the two
    // checks being separate is that each says exactly which range it is.
    expect(isPublicAddress('64:ff9b:2::1')).toBe(true)
  })

  /**
   * `::a.b.c.d` is the deprecated IPv4-compatible form, and it is a parsing trap rather than a
   * range: `Number.parseInt('192.168.1.1', 16)` answers 0x192 without complaining, so the address
   * expanded to something that read as an ordinary public one. Checked as the IPv4 address it
   * carries, the way `::ffff:` already was.
   */
  it.each([
    ['a loopback address', '::127.0.0.1'],
    ['an RFC 1918 address', '::192.168.1.1'],
    ['a public address', '::93.184.216.34'],
  ])('refuses the IPv4-compatible form carrying %s (%s)', (_label, address) => {
    expect(isPublicAddress(address)).toBe(false)
  })

  it.each([
    ['a group that is not hexadecimal at all', '1.2.3.4:5::1'],
    ['a group above ffff', '10000::1'],
    ['a group of five hex digits', 'abcde::1'],
    ['an empty group in the middle', '2001::db8::1'],
  ])('refuses an IPv6 address with %s (%s)', (_label, address) => {
    expect(isPublicAddress(address)).toBe(false)
  })
})

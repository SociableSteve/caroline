/**
 * Whether a resolved address is public. Spec 12, "The client metadata document fetch": the one
 * outbound destination a caller rather than the user chooses, refused unless it resolves to a
 * public address, not loopback, not link-local, not RFC 1918, not unique-local, and not the
 * IPv4-mapped form of any of those.
 *
 * Written against the numeric address only, never against a hostname: the guard's whole point
 * is to check the address a name actually resolved to, so a function that took a hostname and
 * resolved it again would reopen the hole this exists to close. `src/mcp/oauth/client-metadata.ts`
 * is the one caller, and it resolves once, checks the result here, and connects to that same
 * checked address.
 */
import { isIP } from 'node:net'

/** An IPv4 octet range, inclusive at both ends. */
interface Ipv4Range {
  readonly base: readonly [number, number, number, number]
  readonly maskBits: number
}

const ipv4PrivateRanges: readonly Ipv4Range[] = [
  { base: [127, 0, 0, 0], maskBits: 8 }, // loopback
  { base: [169, 254, 0, 0], maskBits: 16 }, // link-local
  { base: [10, 0, 0, 0], maskBits: 8 }, // RFC 1918
  { base: [172, 16, 0, 0], maskBits: 12 }, // RFC 1918
  { base: [192, 168, 0, 0], maskBits: 16 }, // RFC 1918
  { base: [0, 0, 0, 0], maskBits: 8 }, // "this network", not a public destination
]

function ipv4ToInt(octets: readonly [number, number, number, number]): number {
  return ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0
}

function parseIpv4(address: string): readonly [number, number, number, number] | null {
  const parts = address.split('.')
  if (parts.length !== 4) return null

  const octets = parts.map((part) => Number(part))
  if (octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return null

  return octets as [number, number, number, number]
}

function isPrivateIpv4(address: string): boolean {
  const octets = parseIpv4(address)
  if (octets === null) return true // unparsable is not a public address either

  const value = ipv4ToInt(octets)
  return ipv4PrivateRanges.some((range) => {
    const maskedBase = ipv4ToInt(range.base) >>> (32 - range.maskBits)
    const maskedValue = value >>> (32 - range.maskBits)
    return maskedBase === maskedValue
  })
}

/** `::ffff:a.b.c.d`, the IPv4-mapped form an IPv6-only stack can hand back for an IPv4 address.
 * Extracted and checked as the IPv4 address it maps, per spec 12 criterion 35. */
function ipv4MappedAddress(address: string): string | null {
  const match = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
  return match?.[1] ?? null
}

function expandIpv6Groups(address: string): readonly number[] | null {
  const sides = address.split('::')
  if (sides.length > 2) return null

  const parseGroups = (part: string): number[] | null => {
    if (part === '') return []
    const groups = part.split(':').map((group) => Number.parseInt(group, 16))
    return groups.some((group) => Number.isNaN(group)) ? null : groups
  }

  if (sides.length === 1) {
    const groups = parseGroups(sides[0] as string)
    return groups !== null && groups.length === 8 ? groups : null
  }

  const head = parseGroups(sides[0] as string)
  const tail = parseGroups(sides[1] as string)
  if (head === null || tail === null || head.length + tail.length > 8) return null

  const missing = 8 - head.length - tail.length
  return [...head, ...Array(missing).fill(0), ...tail]
}

function isPrivateIpv6(address: string): boolean {
  const groups = expandIpv6Groups(address)
  if (groups === null) return true // unparsable is not a public address either

  const [first, second] = groups as [number, number, ...number[]]

  if (groups.every((group) => group === 0)) return true // "::", unspecified
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true // ::1
  if ((first & 0xffe0) === 0xfe80) return true // fe80::/10, link-local
  if ((first & 0xfe00) === 0xfc00) return true // fc00::/7, unique local

  // ::ffff:0:0/96 is the mapped-address block in its full expanded form; the compact dotted
  // spelling is handled by `ipv4MappedAddress` before this function is ever reached, but a
  // caller could still hand this form to `dns.lookup`'s IPv6 answer.
  if (
    first === 0 &&
    second === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0xffff
  ) {
    const mapped = groups.slice(6)
    return isPrivateIpv4(
      `${(mapped[0]! >> 8) & 0xff}.${mapped[0]! & 0xff}.${(mapped[1]! >> 8) & 0xff}.${mapped[1]! & 0xff}`,
    )
  }

  return false
}

/**
 * True where `address` is safe to connect to as the resolved target of a URL a caller supplied.
 * False for anything unparsable, which is deliberately the same answer as "private": an address
 * this function cannot classify is not one it can call public.
 */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 0) return false

  const mapped = ipv4MappedAddress(address)
  if (mapped !== null) return !isPrivateIpv4(mapped)

  return family === 4 ? !isPrivateIpv4(address) : !isPrivateIpv6(address)
}

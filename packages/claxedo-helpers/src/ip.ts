/**
 * Canonical IP parsing and destination classification.
 *
 * String and prefix checks on a hostname cannot see what a connection
 * actually reaches: `::ffff:7f00:1` is 127.0.0.1, `0x7f000001` is 127.0.0.1,
 * and `2002:7f00:1::` routes to it through 6to4. Parsing to the numeric form
 * first means every spelling of an address lands on the same policy answer.
 *
 * "Private" here means NOT a global unicast destination — loopback,
 * link-local, RFC 1918, CGNAT, benchmarking, documentation, multicast,
 * unspecified, and the reserved blocks. A destination check that asks
 * "is this public" fails closed on everything it did not enumerate.
 */

export type IpAddress =
  | { readonly kind: "v4"; readonly value: number }
  | { readonly kind: "v6"; readonly segments: readonly number[] }

/**
 * One IPv4 numeric part in WHATWG spelling: `0x` hex, a leading `0` octal,
 * else decimal. A part that is none of these fails the whole parse — `1.2.3.x`
 * is a DNS name, not a malformed address.
 */
function ipv4Number(part: string): number | undefined {
  let value: number
  if (/^0[xX][0-9a-fA-F]+$/.test(part)) value = Number.parseInt(part.slice(2), 16)
  else if (/^0[0-7]+$/.test(part)) value = Number.parseInt(part.slice(1), 8)
  else if (/^\d+$/.test(part)) value = Number.parseInt(part, 10)
  else return undefined
  return Number.isSafeInteger(value) ? value : undefined
}

/**
 * WHATWG IPv4: one to four numeric parts, where the last part holds the
 * remaining bytes (`127.1` is 127.0.0.1, `0x7f000001` is too). A trailing dot
 * is dropped the way URL parsing drops it.
 */
function parseIpv4(input: string): number | undefined {
  const parts = input.split(".")
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop()
  if (parts.length < 1 || parts.length > 4) return undefined
  const numbers: number[] = []
  for (const part of parts) {
    const value = ipv4Number(part)
    if (value === undefined) return undefined
    numbers.push(value)
  }
  const last = numbers[numbers.length - 1]!
  if (last >= 256 ** (5 - numbers.length)) return undefined
  for (const value of numbers.slice(0, -1)) if (value > 255) return undefined
  let address = last
  for (let i = 0; i < numbers.length - 1; i++) address += numbers[i]! * 256 ** (3 - i)
  return address >>> 0
}

function hextet(part: string): number | undefined {
  return /^[0-9a-fA-F]{1,4}$/.test(part) ? Number.parseInt(part, 16) : undefined
}

/** A strict dotted-quad tail inside an IPv6 literal — the form URL emits. */
function embeddedQuad(input: string): readonly number[] | undefined {
  const parts = input.split(".")
  if (parts.length !== 4) return undefined
  const octets: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined
    const value = Number.parseInt(part, 10)
    if (value > 255) return undefined
    octets.push(value)
  }
  return octets
}

function parseIpv6(input: string): readonly number[] | undefined {
  let body = input
  let tail: readonly number[] | undefined
  const lastColon = body.lastIndexOf(":")
  if (lastColon >= 0 && body.includes(".")) {
    tail = embeddedQuad(body.slice(lastColon + 1))
    if (!tail) return undefined
    body = body.slice(0, lastColon + 1) + "0:0"
    // Re-parse with the tail replaced by two zero segments; the tail's real
    // value is written back below.
  }
  if ((body.match(/::/g) ?? []).length > 1) return undefined
  let halves: string[]
  if (body.includes("::")) {
    const [left = "", right = ""] = body.split("::")
    const leftParts = left === "" ? [] : left.split(":")
    const rightParts = right === "" ? [] : right.split(":")
    const missing = 8 - leftParts.length - rightParts.length
    if (missing < 1) return undefined
    halves = [...leftParts, ...Array.from({ length: missing }, () => "0"), ...rightParts]
  } else {
    halves = body.split(":")
    if (halves.length !== 8) return undefined
  }
  if (halves.length !== 8) return undefined
  const segments: number[] = []
  for (const part of halves) {
    const value = hextet(part)
    if (value === undefined) return undefined
    segments.push(value)
  }
  if (tail) {
    segments[6] = tail[0]! * 256 + tail[1]!
    segments[7] = tail[2]! * 256 + tail[3]!
  }
  return segments
}

/**
 * Parses every spelling of an IP literal: dotted/hex/octal/shorthand IPv4,
 * bracketed or bare IPv6, and IPv6 with an embedded dotted-quad tail
 * (`::ffff:10.0.0.1`). Returns undefined for DNS names and malformed input.
 */
export function parseIpAddress(input: string | undefined | null): IpAddress | undefined {
  if (!input) return undefined
  let host = input.trim().toLowerCase()
  if (host.startsWith("[") && host.endsWith("]") && host.includes(":")) host = host.slice(1, -1)
  if (host.includes(":")) {
    const segments = parseIpv6(host)
    return segments ? { kind: "v6", segments } : undefined
  }
  const value = parseIpv4(host)
  return value === undefined ? undefined : { kind: "v4", value }
}

/** Non-global IPv4 destinations, as [base, prefixBits] CIDRs. */
const V4_PRIVATE: readonly (readonly [number, number])[] = [
  [0x00000000, 8], // 0.0.0.0/8 "this network"
  [0x0a000000, 8], // 10.0.0.0/8 private
  [0x64400000, 10], // 100.64.0.0/10 CGNAT
  [0x7f000000, 8], // 127.0.0.0/8 loopback
  [0xa9fe0000, 16], // 169.254.0.0/16 link-local
  [0xac100000, 12], // 172.16.0.0/12 private
  [0xc0000000, 24], // 192.0.0.0/24 protocol assignments
  [0xc0000200, 24], // 192.0.2.0/24 TEST-NET-1
  [0xc01fc400, 24], // 192.31.196.0/24 AS112
  [0xc034c100, 24], // 192.52.193.0/24 AMT
  [0xc0586300, 24], // 192.88.99.0/24 6to4 relay (deprecated)
  [0xc0a80000, 16], // 192.168.0.0/16 private
  [0xc0af3000, 24], // 192.175.48.0/24 direct delegation AS112
  [0xc6120000, 15], // 198.18.0.0/15 benchmarking
  [0xc6336400, 24], // 198.51.100.0/24 TEST-NET-2
  [0xcb007100, 24], // 203.0.113.0/24 TEST-NET-3
  [0xe0000000, 4], // 224.0.0.0/4 multicast
  [0xf0000000, 4], // 240.0.0.0/4 reserved + broadcast
]

function inCidr(value: number, base: number, bits: number): boolean {
  return ((value ^ base) >>> (32 - bits)) === 0
}

function isPrivateIpv4(value: number): boolean {
  return V4_PRIVATE.some(([base, bits]) => inCidr(value, base, bits))
}

function isLoopbackIpv4(value: number): boolean {
  return inCidr(value, 0x7f000000, 8)
}

/**
 * The IPv4 an IPv6 literal secretly carries, in the forms that embed one:
 * mapped `::ffff:0:0/96`, compatible `::/96`, NAT64 `64:ff9b::/96`,
 * 6to4 `2002::/16` (v4 in bits 16–48), and Teredo `2001::/32`
 * (v4 XOR 0xffffffff in the last 32 bits). Without this, each tunnel spelling
 * is a private-address bypass.
 */
function embeddedIpv4(segments: readonly number[]): number | undefined {
  const [a, b, c, d, e, f, g, h] = segments
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0) {
    if (f === 0xffff || f === 0) return (g! * 65536 + h!) >>> 0
  }
  if (a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0) return (g! * 65536 + h!) >>> 0
  if (a === 0x2002) return (b! * 65536 + c!) >>> 0
  if (a === 0x2001 && b === 0) return (((g! ^ 0xffff) * 65536 + (h! ^ 0xffff)) >>> 0)
  return undefined
}

function isUnspecified(segments: readonly number[]): boolean {
  return segments.every((segment) => segment === 0)
}

function isIpv6Loopback(segments: readonly number[]): boolean {
  return segments.slice(0, 7).every((segment) => segment === 0) && segments[7] === 1
}

/** Loopback only — 127.0.0.0/8, ::1, and every embedded spelling of them. */
export function isLoopbackIpAddress(ip: IpAddress): boolean {
  if (ip.kind === "v4") return isLoopbackIpv4(ip.value)
  if (isIpv6Loopback(ip.segments)) return true
  const embedded = embeddedIpv4(ip.segments)
  return embedded !== undefined && isLoopbackIpv4(embedded)
}

/**
 * Not a global unicast destination. Any IPv6 whose embedded IPv4 is private
 * is private by the same rule; a public embedded address is public, since the
 * packet genuinely reaches that public host.
 */
export function isPrivateIpAddress(ip: IpAddress): boolean {
  if (ip.kind === "v4") return isPrivateIpv4(ip.value)
  const segments = ip.segments
  if (isUnspecified(segments) || isIpv6Loopback(segments)) return true
  const first = segments[0]!
  if ((first & 0xff00) === 0xff00) return true // ff00::/8 multicast
  if ((first & 0xfe00) === 0xfc00) return true // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if ((first & 0xffc0) === 0xfec0) return true // fec0::/10 site-local (deprecated)
  if (first === 0x0100 && segments[1] === 0 && segments[2] === 0 && segments[3] === 0) return true // 100::/64 discard
  if (first === 0x2001 && segments[1] === 0x0db8) return true // 2001:db8::/32 documentation
  const embedded = embeddedIpv4(segments)
  if (embedded !== undefined) return isPrivateIpv4(embedded)
  return false
}

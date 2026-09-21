import { describe, expect, test } from "bun:test"
import { isLoopbackIpAddress, isPrivateIpAddress, parseIpAddress } from "./ip"

describe("parseIpAddress", () => {
  test("reads dotted, hex, octal, and shorthand IPv4 to one value", () => {
    for (const spelling of ["127.0.0.1", "0x7f000001", "017700000001", "2130706433", "127.1", "0x7f.0.0.1"]) {
      expect(parseIpAddress(spelling)).toEqual({ kind: "v4", value: 0x7f000001 })
    }
  })

  test("reads full, compressed, and embedded-quad IPv6 to one value", () => {
    expect(parseIpAddress("::ffff:10.0.0.1")).toEqual({
      kind: "v6",
      segments: [0, 0, 0, 0, 0, 0xffff, 0x0a00, 0x0001],
    })
    expect(parseIpAddress("[::ffff:a00:1]")).toEqual(parseIpAddress("::ffff:10.0.0.1"))
    expect(parseIpAddress("fe80::1")?.kind).toBe("v6")
  })

  test("returns undefined for DNS names and malformed input", () => {
    for (const input of ["mcp.example", "localhost", "", undefined, null, "1.2.3.4.5", "::g", "1:2:3:4:5:6:7:8:9", "1::2::3"]) {
      expect(parseIpAddress(input)).toBeUndefined()
    }
  })
})

describe("isPrivateIpAddress", () => {
  test("refuses every private and reserved IPv4 range", () => {
    for (const spelling of [
      "0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.169.254",
      "172.16.0.1", "172.31.255.255", "192.0.0.1", "192.0.2.1", "192.88.99.1",
      "192.168.1.1", "198.18.0.1", "198.19.255.1", "198.51.100.1", "203.0.113.1",
      "224.0.0.1", "240.0.0.1", "255.255.255.255",
    ]) {
      expect(isPrivateIpAddress(parseIpAddress(spelling)!), spelling).toBe(true)
    }
  })

  test("refuses private IPv4 inside every IPv6 embedding", () => {
    for (const spelling of [
      "::ffff:10.0.0.1", "[::ffff:7f00:1]", "::ffff:a9fe:a9fe", // mapped
      "::10.0.0.1", "::127.0.0.1", // v4-compatible
      "64:ff9b::a00:1", "64:ff9b::10.0.0.1", // NAT64
      "2002:a00:1::1", "2002:7f00:1::1", // 6to4
      "2001::5efe:f5ff:fffe", // Teredo (client 10.0.0.1)
    ]) {
      expect(isPrivateIpAddress(parseIpAddress(spelling)!), spelling).toBe(true)
    }
  })

  test("refuses non-global IPv6 ranges", () => {
    for (const spelling of ["::", "::1", "fc00::1", "fd00::1", "fe80::1", "fec0::1", "ff02::1", "100::1", "2001:db8::1"]) {
      expect(isPrivateIpAddress(parseIpAddress(spelling)!), spelling).toBe(true)
    }
  })

  test("permits public IPv4, public IPv6, and public addresses in embeddings", () => {
    for (const spelling of ["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::1"]) {
      expect(isPrivateIpAddress(parseIpAddress(spelling)!), spelling).toBe(false)
    }
  })
})

describe("isLoopbackIpAddress", () => {
  test("is 127/8, ::1, and their embedded spellings", () => {
    for (const spelling of ["127.0.0.1", "127.255.0.1", "::1", "::ffff:127.0.0.1", "::127.0.0.1"]) {
      expect(isLoopbackIpAddress(parseIpAddress(spelling)!), spelling).toBe(true)
    }
    for (const spelling of ["10.0.0.1", "8.8.8.8", "::ffff:10.0.0.1", "fe80::1"]) {
      expect(isLoopbackIpAddress(parseIpAddress(spelling)!), spelling).toBe(false)
    }
  })
})

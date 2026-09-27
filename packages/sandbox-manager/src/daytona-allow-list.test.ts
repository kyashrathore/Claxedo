import { describe, expect, test } from "vitest"
import { formatDaytonaAllowList, formatDaytonaDomainAllowList } from "./daytona-allow-list"

describe("formatDaytonaAllowList", () => {
  test("joins legal CIDRs with commas", () => {
    expect(formatDaytonaAllowList(["10.0.0.0/8", "192.168.1.0/24"])).toBe("10.0.0.0/8,192.168.1.0/24")
  })

  test("keeps Daytona's first ten entries", () => {
    const cidrs = Array.from({ length: 15 }, (_, i) => `10.0.${i}.0/24`)
    expect(formatDaytonaAllowList(cidrs).split(",")).toEqual(cidrs.slice(0, 10))
  })

  test("refuses an entry that would splice another allowance", () => {
    expect(() => formatDaytonaAllowList(["10.0.0.0/8,0.0.0.0/0"])).toThrow("not a legal IPv4 CIDR")
    expect(() => formatDaytonaAllowList(["10.0.0.256/8"])).toThrow("not a legal IPv4 CIDR")
  })
})

describe("formatDaytonaDomainAllowList", () => {
  test("deduplicates without truncating", () => {
    const hosts = Array.from({ length: 12 }, (_, i) => `h${i}.example.com`)
    expect(formatDaytonaDomainAllowList([...hosts, hosts[0]]).split(",")).toEqual(hosts)
  })

  test("refuses an entry carrying a delimiter", () => {
    expect(() => formatDaytonaDomainAllowList(["a.example.com,evil.example"])).toThrow("not a legal hostname")
  })
})

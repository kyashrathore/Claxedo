import { describe, expect, test } from "vitest"
import { formatDaytonaAllowList, resolveAllowListCidrs, resolveSandboxNetworkPolicy, type PolicyEntry } from "./resolve"

describe("network resolve", () => {
  test("resolveAllowListCidrs always includes control-plane CIDRs", async () => {
    const cidrs = await resolveAllowListCidrs([])
    expect(cidrs).toContain("127.0.0.1/32")
  })

  test("resolveAllowListCidrs resolves IP addresses as /32", async () => {
    const entries: PolicyEntry[] = [{ target: "192.168.1.100", kind: "host" }]
    const cidrs = await resolveAllowListCidrs(entries)
    expect(cidrs).toContain("192.168.1.100/32")
  })

  test("resolveAllowListCidrs passes through CIDR notation", async () => {
    const entries: PolicyEntry[] = [{ target: "10.0.0.0/8", kind: "host" }]
    const cidrs = await resolveAllowListCidrs(entries)
    expect(cidrs).toContain("10.0.0.0/8")
  })

  test("resolveAllowListCidrs resolves server URL host", async () => {
    const cidrs = await resolveAllowListCidrs([], "http://127.0.0.1:3001")
    expect(cidrs).toContain("127.0.0.1/32")
  })

  test("resolveAllowListCidrs deduplicates CIDRs", async () => {
    const entries: PolicyEntry[] = [
      { target: "127.0.0.1", kind: "host" },
      { target: "127.0.0.1", kind: "host" },
    ]
    const cidrs = await resolveAllowListCidrs(entries)
    const count = cidrs.filter((c) => c === "127.0.0.1/32").length
    expect(count).toBe(1)
  })

  test("resolveAllowListCidrs handles unresolvable hostnames gracefully", async () => {
    const entries: PolicyEntry[] = [{ target: "this-host-does-not-exist.invalid", kind: "host" }]
    const cidrs = await resolveAllowListCidrs(entries)
    // Should not throw, just skip the unresolvable entry
    expect(cidrs).toContain("127.0.0.1/32")
  })

  test("resolveSandboxNetworkPolicy preserves host/domain intent", async () => {
    const net = await resolveSandboxNetworkPolicy([
      { target: "api.openai.com", kind: "host" },
      { target: "*.anthropic.com", kind: "domain" },
    ])
    expect(net.mode).toBe("restricted")
    expect(net.hosts).toContain("api.openai.com")
    expect(net.hosts).toContain("*.anthropic.com")
  })

  test("resolveSandboxNetworkPolicy expands groups into hosts", async () => {
    const net = await resolveSandboxNetworkPolicy([{ target: "openai", kind: "group" }])
    expect(net.hosts).toContain("openai.com")
  })

  test("resolveSandboxNetworkPolicy skips unresolved wildcard-only targets in cidr mode", async () => {
    const net = await resolveSandboxNetworkPolicy(
      [{ target: "openai", kind: "group" }],
      "http://localhost:3001",
      "cidr",
    )
    expect(net.rules.every((item) => item.cidrs.length > 0)).toBe(true)
    expect(net.cidrs).toContain("127.0.0.1/32")
  })

  test("resolveSandboxNetworkPolicy includes DNS resolvers in restricted cidr mode", async () => {
    const net = await resolveSandboxNetworkPolicy(
      [{ target: "opencode", kind: "group" }],
      undefined,
      "cidr",
    )
    expect(net.cidrs).toContain("1.1.1.1/32")
    expect(net.cidrs).toContain("8.8.8.8/32")
  })

  test("formatDaytonaAllowList joins with commas", () => {
    const result = formatDaytonaAllowList(["10.0.0.0/8", "192.168.1.0/24"])
    expect(result).toBe("10.0.0.0/8,192.168.1.0/24")
  })

  test("formatDaytonaAllowList truncates to 10 entries", () => {
    const cidrs = Array.from({ length: 15 }, (_, i) => `10.0.${i}.0/24`)
    const result = formatDaytonaAllowList(cidrs)
    expect(result.split(",").length).toBe(10)
  })
})

import { describe, expect, test } from "vitest"
import { resolveSandboxNetworkPolicy, type PolicyEntry } from "./resolve"

describe("network resolve", () => {
  test("the policy CIDRs always include the control plane", async () => {
    const cidrs = (await resolveSandboxNetworkPolicy([])).cidrs
    expect(cidrs).toContain("127.0.0.1/32")
  })

  test("the policy CIDRs carry an IP address as a /32", async () => {
    const entries: PolicyEntry[] = [{ target: "192.168.1.100", kind: "host" }]
    const cidrs = (await resolveSandboxNetworkPolicy(entries)).cidrs
    expect(cidrs).toContain("192.168.1.100/32")
  })

  test("the policy CIDRs pass CIDR notation through", async () => {
    const entries: PolicyEntry[] = [{ target: "10.0.0.0/8", kind: "host" }]
    const cidrs = (await resolveSandboxNetworkPolicy(entries)).cidrs
    expect(cidrs).toContain("10.0.0.0/8")
  })

  test("the policy CIDRs resolve the server URL host", async () => {
    const cidrs = (await resolveSandboxNetworkPolicy([], "http://127.0.0.1:3001")).cidrs
    expect(cidrs).toContain("127.0.0.1/32")
  })

  test("the policy CIDRs are deduplicated", async () => {
    const entries: PolicyEntry[] = [
      { target: "127.0.0.1", kind: "host" },
      { target: "127.0.0.1", kind: "host" },
    ]
    const cidrs = (await resolveSandboxNetworkPolicy(entries)).cidrs
    const count = cidrs.filter((c) => c === "127.0.0.1/32").length
    expect(count).toBe(1)
  })

  test("the policy CIDRs skip an unresolvable hostname", async () => {
    const entries: PolicyEntry[] = [{ target: "this-host-does-not-exist.invalid", kind: "host" }]
    const cidrs = (await resolveSandboxNetworkPolicy(entries)).cidrs
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
    expect(net.rules).toEqual([
      expect.objectContaining({
        target: "openai",
        hosts: expect.arrayContaining(["openai.com"]),
        cidrs: expect.arrayContaining(["1.1.1.1/32", "8.8.8.8/32"]),
      }),
    ])
  })

  test("resolveSandboxNetworkPolicy skips unresolved wildcard-only targets in cidr mode", async () => {
    const net = await resolveSandboxNetworkPolicy(
      [{ target: "openai", kind: "group" }],
      "http://localhost:3001",
    )
    const rules = net.rules ?? []
    expect(rules).toHaveLength(1)
    expect(rules[0].target).toBe("openai")
    expect(rules.every((item) => item.cidrs.length > 0)).toBe(true)
    expect(net.cidrs).toContain("127.0.0.1/32")
  })

  test("resolveSandboxNetworkPolicy records per-entry rule details", async () => {
    const net = await resolveSandboxNetworkPolicy([
      { target: "10.0.0.0/8", kind: "host" },
      { target: "*.anthropic.com", kind: "domain" },
    ])

    expect(net.rules).toEqual([
      {
        target: "10.0.0.0/8",
        hosts: [],
        cidrs: ["10.0.0.0/8"],
      },
      expect.objectContaining({
        target: "*.anthropic.com",
        hosts: ["*.anthropic.com"],
      }),
    ])
  })

  test("resolveSandboxNetworkPolicy includes DNS resolvers in restricted cidr mode", async () => {
    const net = await resolveSandboxNetworkPolicy(
      [{ target: "anthropic", kind: "group" }],
      undefined,
    )
    expect(net.cidrs).toContain("1.1.1.1/32")
    expect(net.cidrs).toContain("8.8.8.8/32")
  })
})

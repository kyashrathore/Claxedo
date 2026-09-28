import { expect, test } from "bun:test"
import { draftProbeKey, DraftProbeCache } from "./probe-cache"
import type { DraftLaunch } from "./transport"

const draft = (placeholder: string, leaseGeneration = "lease-1"): DraftLaunch => ({
  workspaceId: "w1", directory: "/work", locality: "local", owner: { kind: "person", userId: "member" },
  config: { harness: { id: "codex", access: "native" } }, projection: { generation: "g1", mcpServers: [], pluginRoots: [], notApplied: [] },
  credentials: { providers: { "codex-app-server": { baseUrl: "http://127.0.0.1:47509/v1", placeholder, authMode: "api-key" } }, secrets: { token: placeholder }, leaseGeneration },
})

test("a draft probe key names the launch identity and never a placeholder or secret", () => {
  expect(draftProbeKey(draft("secret-one"))).toBe(draftProbeKey(draft("secret-two")))
  expect(draftProbeKey(draft("secret-one"))).not.toContain("secret-")
  expect(draftProbeKey(draft("secret-one", "lease-2"))).not.toBe(draftProbeKey(draft("secret-one")))
  expect(draftProbeKey(draft("x"), true)).not.toBe(draftProbeKey(draft("x"), false))
})

test("a cached probe is shared, peekable once settled, expired on the clock, capped, and dropped when it rejects", async () => {
  let now = 1_000
  const cache = new DraftProbeCache<string>({ now: () => now, setTimeout, clearTimeout }, 30_000, 2)
  expect(cache.peek("a")).toBeUndefined()
  const first = cache.set("a", Promise.resolve("one"))
  expect(cache.get("a")).toBe(first)
  expect(cache.peek("a")).toBeUndefined()
  await first
  expect(cache.peek("a")).toBe("one")
  void cache.set("b", Promise.resolve("two"))
  void cache.set("c", Promise.resolve("three"))
  expect([...cache.keys()]).toEqual(["b", "c"])
  const failing = cache.set("d", Promise.reject(new Error("probe failed")))
  await expect(failing).rejects.toThrow("probe failed")
  await Promise.resolve()
  expect(cache.get("d")).toBeUndefined()
  now += 30_000
  expect(cache.get("b")).toBeUndefined()
  expect(cache.size).toBe(0)
})

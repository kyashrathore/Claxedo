import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { draftProbeKey, DraftProbeCache } from "./cache"
import type { DraftLaunch } from "../contract/transport"

const draft = (placeholder: string, leaseGeneration = "lease-1"): DraftLaunch => ({
  workspaceId: "w1", directory: "/work", locality: "local", owner: { kind: "person", userId: "member" },
  config: { harness: { id: "codex", access: "native" } }, projection: { generation: "g1", mcpServers: [], pluginRoots: [], notApplied: [] },
  credentials: { machineLoginAllowed: true, accountOwner: "fixture-owner", providers: { openai: { baseUrl: "http://127.0.0.1:47509/v1", placeholder, authMode: "api-key" } }, secrets: { token: placeholder }, leaseGeneration },
})

let root: string
let settings: string
let files: { files: string[] }

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "probe-cache-"))
  settings = path.join(root, "settings.json")
  files = { files: [settings, path.join(root, "absent", "auth.json")] }
})

afterEach(async () => { await fs.rm(root, { recursive: true, force: true }) })

function counted(onProbe: (count: number) => Promise<void> = async () => {}) {
  let count = 0
  return { probe: async () => { count += 1; await onProbe(count); return `answer-${count}` }, count: () => count }
}

test("a draft probe key names the launch identity and never a placeholder or secret", () => {
  expect(draftProbeKey(draft("secret-one"))).toBe(draftProbeKey(draft("secret-two")))
  expect(draftProbeKey(draft("secret-one"))).not.toContain("secret-")
  expect(draftProbeKey(draft("secret-one", "lease-2"))).not.toBe(draftProbeKey(draft("secret-one")))
  expect(draftProbeKey(draft("x"), true)).not.toBe(draftProbeKey(draft("x"), false))
})

test("an answer is kept while the files its probe read are unchanged, and concurrent reads share one probe", async () => {
  const cache = new DraftProbeCache<string>()
  const probe = counted()
  expect(await Promise.all([cache.read("a", files, probe.probe), cache.read("a", files, probe.probe)])).toEqual(["answer-1", "answer-1"])
  expect(await cache.read("a", files, probe.probe)).toBe("answer-1")
  expect(await cache.peek("a", files)).toBe("answer-1")
  expect(probe.count()).toBe(1)
})

test("a created, edited or removed input file probes again, and peek drops the stale answer without probing", async () => {
  const cache = new DraftProbeCache<string>()
  const probe = counted()
  await cache.read("a", files, probe.probe)
  await fs.writeFile(settings, "{}")
  expect(await cache.peek("a", files)).toBeUndefined()
  expect(probe.count()).toBe(1)
  expect(await cache.read("a", files, probe.probe)).toBe("answer-2")
  await fs.writeFile(settings, '{"defaultModel":"other"}')
  expect(await cache.read("a", files, probe.probe)).toBe("answer-3")
  await fs.rm(settings)
  expect(await cache.read("a", files, probe.probe)).toBe("answer-4")
  expect(await cache.read("a", files, probe.probe)).toBe("answer-4")
})

test("an answer read while an input file changed is returned but not kept", async () => {
  const cache = new DraftProbeCache<string>()
  const probe = counted(async (count) => { if (count === 1) await fs.writeFile(settings, "{}") })
  expect(await cache.read("a", files, probe.probe)).toBe("answer-1")
  expect(await cache.peek("a", files)).toBeUndefined()
  expect(await cache.read("a", files, probe.probe)).toBe("answer-2")
  expect(await cache.read("a", files, probe.probe)).toBe("answer-2")
})

test("a failed probe is not kept, an unreadable input fails the read, and the oldest entry leaves at the cap", async () => {
  const cache = new DraftProbeCache<string>(2)
  let fail = true
  const probe = async () => { if (fail) throw new Error("probe failed"); return "ok" }
  await expect(cache.read("a", files, probe)).rejects.toThrow("probe failed")
  expect(cache.size).toBe(0)
  fail = false
  expect(await cache.read("a", files, probe)).toBe("ok")
  await expect(cache.read("x", { files: [path.join(root, "nul\0")] }, probe)).rejects.toThrow()
  await cache.read("b", files, probe)
  await cache.read("c", files, probe)
  expect(await cache.peek("a", files)).toBeUndefined()
  expect(cache.size).toBe(2)
})

test("an answer with no input files is kept only for its max age, measured from when its probe started", async () => {
  let now = 1_000
  const inputs = { files: [], maxAge: { ms: 30_000, clock: { now: () => now } } }
  const cache = new DraftProbeCache<string>()
  const probe = counted(async () => { now += 5_000 })
  expect(await cache.read("a", inputs, probe.probe)).toBe("answer-1")
  now = 30_999
  expect(await cache.peek("a", inputs)).toBe("answer-1")
  expect(await cache.read("a", inputs, probe.probe)).toBe("answer-1")
  now = 31_000
  expect(await cache.peek("a", inputs)).toBeUndefined()
  expect(await cache.read("a", inputs, probe.probe)).toBe("answer-2")
  expect(probe.count()).toBe(2)
})

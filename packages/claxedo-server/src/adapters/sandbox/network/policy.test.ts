import { describe, expect, test, afterAll } from "vitest"
import { realpathSync, mkdirSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"

const root = path.join(realpathSync(os.tmpdir()), `network-policy-test-${randomUUID().slice(0, 8)}`)
mkdirSync(root, { recursive: true })
const prev = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root

// Force DB initialization
const { ClaxedoDB } = await import("../../../platform/db/db")
ClaxedoDB.Drizzle() // ensure initialized

const {
  createPolicy,
  listPolicies,
  getPolicy,
  updatePolicy,
  deletePolicy,
  resolveEffectivePolicy,
  isTargetAllowed,
  ensureHostForUrl,
  removeAutoHostsForSource,
  ensureHostForRepo,
  syncMcpHosts,
} = await import("./policy")

describe("network policy", () => {
  afterAll(async () => {
    ClaxedoDB.close()
    await fs.rm(root, { recursive: true, force: true })
    process.env.CLAXEDO_DATA_DIR = prev
  })

  test("createPolicy stores a host entry", () => {
    const result = createPolicy({
      workspace_id: "ws-1",
      target: "api.example.com",
      kind: "host",
    })
    expect("error" in result).toBe(false)
    if ("error" in result) return
    expect(result.target).toBe("api.example.com")
    expect(result.kind).toBe("host")
  })

  test("createPolicy rejects malformed host", () => {
    const result = createPolicy({
      target: "not valid host!@#",
      kind: "host",
    })
    expect("error" in result).toBe(true)
  })

  test("createPolicy rejects domain without wildcard prefix", () => {
    const result = createPolicy({
      target: "example.com",
      kind: "domain",
    })
    expect("error" in result).toBe(true)
    if (!("error" in result)) return
    expect(result.error).toContain("must start with *.")
  })

  test("createPolicy accepts valid wildcard domain", () => {
    const result = createPolicy({
      workspace_id: "ws-1",
      target: "*.example.com",
      kind: "domain",
    })
    expect("error" in result).toBe(false)
  })

  test("createPolicy rejects unknown group", () => {
    const result = createPolicy({
      target: "nonexistent-provider",
      kind: "group",
    })
    expect("error" in result).toBe(true)
    if (!("error" in result)) return
    expect(result.error).toContain("Unknown group")
  })

  test("createPolicy accepts known group", () => {
    const result = createPolicy({
      workspace_id: "ws-1",
      target: "anthropic",
      kind: "host",
    })
    expect("error" in result).toBe(false)
  })

  test("listPolicies returns all entries", () => {
    const all = listPolicies()
    expect(all.length).toBeGreaterThanOrEqual(3)
  })

  test("listPolicies filters by workspace", () => {
    const ws1 = listPolicies("ws-1")
    expect(ws1.length).toBeGreaterThanOrEqual(1)
    for (const entry of ws1) {
      expect(entry.workspace_id === null || entry.workspace_id === "ws-1").toBe(true)
    }
  })

  test("getPolicy retrieves by ID", () => {
    const all = listPolicies()
    const entry = getPolicy(all[0]!.id)
    expect(entry).toBeTruthy()
    expect(entry!.id).toBe(all[0]!.id)
  })

  test("updatePolicy changes target", () => {
    const created = createPolicy({
      target: "old.example.com",
      kind: "host",
    })
    if ("error" in created) throw new Error(created.error)
    const updated = updatePolicy(created.id, { target: "new.example.com" })
    expect(updated).toBeTruthy()
    if (!updated || "error" in updated) throw new Error("update failed")
    expect(updated.target).toBe("new.example.com")
  })

  test("deletePolicy removes entry", () => {
    const created = createPolicy({
      target: "delete-me.example.com",
      kind: "host",
    })
    if ("error" in created) throw new Error(created.error)
    expect(deletePolicy(created.id)).toBe(true)
    expect(getPolicy(created.id)).toBeUndefined()
  })

  test("resolveEffectivePolicy always includes control-plane hosts", () => {
    const allowed = resolveEffectivePolicy("ws-nonexistent")
    expect(allowed).toContain("127.0.0.1")
    expect(allowed).toContain("localhost")
  })

  test("resolveEffectivePolicy includes workspace entries", () => {
    const allowed = resolveEffectivePolicy("ws-1")
    expect(allowed).toContain("api.example.com")
  })

  test("resolveEffectivePolicy expands groups", () => {
    const allowed = resolveEffectivePolicy("ws-1")
    expect(allowed).toContain("*.anthropic.com")
    expect(allowed).toContain("claude.ai")
  })

  test("isTargetAllowed blocks unknown targets", () => {
    // evil.example.com would match *.example.com, so use a completely different domain
    expect(isTargetAllowed("ws-1", "evil.attacksite.net")).toBe(false)
  })

  test("isTargetAllowed permits configured hosts", () => {
    expect(isTargetAllowed("ws-1", "api.example.com")).toBe(true)
  })

  test("isTargetAllowed matches wildcard domains", () => {
    expect(isTargetAllowed("ws-1", "sub.example.com")).toBe(true)
    expect(isTargetAllowed("ws-1", "deep.sub.example.com")).toBe(true)
  })

  test("isTargetAllowed does not match sibling roots for wildcard", () => {
    // *.example.com should NOT match example.com itself
    expect(isTargetAllowed("ws-1", "example.com")).toBe(false)
  })

  test("isTargetAllowed always permits control-plane hosts", () => {
    expect(isTargetAllowed("ws-nonexistent", "127.0.0.1")).toBe(true)
    expect(isTargetAllowed("ws-nonexistent", "localhost")).toBe(true)
  })

  // ── Auto-sync ───────────────────────────────────────────────────────

  test("ensureHostForUrl auto-adds host entry for URL", () => {
    ensureHostForUrl("https://mcp.remote-tool.io/sse", "mcp:my-tool")
    const all = listPolicies()
    const entry = all.find((p) => p.target === "mcp.remote-tool.io" && p.kind === "host")
    expect(entry).toBeTruthy()
    expect(entry!.constraints.auto).toBe(true)
    expect((entry!.constraints as Record<string, unknown>).source).toBe("mcp:my-tool")
  })

  test("ensureHostForUrl is idempotent", () => {
    ensureHostForUrl("https://mcp.remote-tool.io/v2", "mcp:my-tool-2")
    const all = listPolicies()
    const entries = all.filter((p) => p.target === "mcp.remote-tool.io")
    expect(entries.length).toBe(1)
  })

  test("ensureHostForUrl skips localhost/127.0.0.1", () => {
    const before = listPolicies().length
    ensureHostForUrl("http://localhost:3000", "mcp:local")
    ensureHostForUrl("http://127.0.0.1:4096", "mcp:local2")
    expect(listPolicies().length).toBe(before)
  })

  test("removeAutoHostsForSource removes only matching auto entries", () => {
    ensureHostForUrl("https://ephemeral.example.com", "mcp:temp-tool")
    let all = listPolicies()
    expect(all.find((p) => p.target === "ephemeral.example.com")).toBeTruthy()

    removeAutoHostsForSource("mcp:temp-tool")
    all = listPolicies()
    expect(all.find((p) => p.target === "ephemeral.example.com")).toBeFalsy()
  })

  test("ensureHostForRepo adds host for https repo URL", () => {
    ensureHostForRepo("https://custom-git.internal.corp/user/repo.git")
    const all = listPolicies()
    expect(all.find((p) => p.target === "custom-git.internal.corp" && p.kind === "host")).toBeTruthy()
  })

  test("ensureHostForRepo adds host for git@ SSH URL", () => {
    ensureHostForRepo("git@private-git.corp:user/repo.git")
    const all = listPolicies()
    expect(all.find((p) => p.target === "private-git.corp" && p.kind === "host")).toBeTruthy()
  })

  test("syncMcpHosts adds entries for all remote MCP servers", () => {
    syncMcpHosts({
      "local-tool": { type: "stdio" },
      "remote-search": { type: "remote", url: "https://search.ai.example.com/mcp" },
      "remote-plugin": { type: "remote", url: "https://plugin.ai.example.com/v1" },
    })
    const all = listPolicies()
    expect(all.find((p) => p.target === "search.ai.example.com")).toBeTruthy()
    expect(all.find((p) => p.target === "plugin.ai.example.com")).toBeTruthy()
  })
})

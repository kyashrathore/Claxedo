import { describe, expect, test, beforeEach, afterAll } from "vitest"
import { realpathSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"

const root = path.join(realpathSync(os.tmpdir()), `session-runner-test-${randomUUID().slice(0, 8)}`)
const prev = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root

const mod = await import("./session-runner")

function file() {
  return path.join(root, "agent-core", "session-runners.json")
}

async function saved() {
  return JSON.parse(await fs.readFile(file(), "utf-8")) as Array<{
    workspaceId: string
    sessionId: string
    config: { runner: { type: string; binary?: string }; model?: string }
    updatedAt: number
  }>
}

describe("session runner", () => {
  beforeEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true })
    process.env.CLAXEDO_DATA_DIR = prev
  })

  // ── set / get ────────────────────────────────────────────────────────

  test("stores and retrieves a runner binding for a workspace+session pair", () => {
    mod.setSessionRunner("ws_1", "ses_1", { type: "claude-acp" })
    const runner = mod.getSessionRunner("ws_1", "ses_1")
    expect(runner).toBeDefined()
    expect(runner!.type).toBe("claude-acp")
    expect(runner!.binary).toBeTruthy() // binary is auto-inferred
  })

  test("returns undefined for unbound session", () => {
    const runner = mod.getSessionRunner("ws_missing", "ses_missing")
    expect(runner).toBeUndefined()
  })

  test("overwrites previous binding on re-set", () => {
    mod.setSessionRunner("ws_2", "ses_2", { type: "claude-acp" })
    mod.setSessionRunner("ws_2", "ses_2", { type: "codex-acp" })
    const runner = mod.getSessionRunner("ws_2", "ses_2")
    expect(runner!.type).toBe("codex-acp")
  })

  test("isolates bindings between different sessions in the same workspace", () => {
    mod.setSessionRunner("ws_3", "ses_a", { type: "claude-acp" })
    mod.setSessionRunner("ws_3", "ses_b", { type: "opencode" })

    expect(mod.getSessionRunner("ws_3", "ses_a")!.type).toBe("claude-acp")
    expect(mod.getSessionRunner("ws_3", "ses_b")!.type).toBe("opencode")
  })

  test("isolates bindings between different workspaces with the same session id", () => {
    mod.setSessionRunner("ws_a", "ses_same", { type: "claude-acp" })
    mod.setSessionRunner("ws_b", "ses_same", { type: "cursor-acp" })

    expect(mod.getSessionRunner("ws_a", "ses_same")!.type).toBe("claude-acp")
    expect(mod.getSessionRunner("ws_b", "ses_same")!.type).toBe("cursor-acp")
  })

  // ── delete ───────────────────────────────────────────────────────────

  test("removes a binding and subsequent get returns undefined", () => {
    mod.setSessionRunner("ws_del", "ses_del", { type: "codex-acp" })
    mod.deleteSessionRunner("ws_del", "ses_del")
    expect(mod.getSessionRunner("ws_del", "ses_del")).toBeUndefined()
  })

  test("delete of nonexistent binding is a no-op", () => {
    // should not throw
    mod.deleteSessionRunner("ws_noop", "ses_noop")
  })

  // ── listSessionRunners ───────────────────────────────────────────────

  test("lists only runners for the specified workspace", () => {
    mod.setSessionRunner("ws_list", "ses_1", { type: "claude-acp" })
    mod.setSessionRunner("ws_list", "ses_2", { type: "codex-acp" })
    mod.setSessionRunner("ws_other", "ses_3", { type: "opencode" })

    const list = mod.listSessionRunners("ws_list")
    expect(list).toHaveLength(2)
    expect(list.every((row) => row.workspaceId === "ws_list")).toBe(true)
    const types = list.map((row) => row.runner.type).sort()
    expect(types).toEqual(["claude-acp", "codex-acp"])
  })

  test("returns empty list for workspace with no bindings", () => {
    expect(mod.listSessionRunners("ws_empty_" + randomUUID())).toEqual([])
  })

  // ── normalize ────────────────────────────────────────────────────────

  test("normalize infers binary for acp types", () => {
    const runner = mod.normalize({ type: "claude-acp" })
    expect(runner.type).toBe("claude-acp")
    expect(runner.binary).toBeTruthy()
    expect(typeof runner.binary).toBe("string")
  })

  test("normalize returns opencode type without binary", () => {
    const runner = mod.normalize({ type: "opencode" })
    expect(runner.type).toBe("opencode")
    expect(runner.binary).toBeUndefined()
  })

  test("normalize preserves explicit binary", () => {
    const runner = mod.normalize({ type: "codex-acp", binary: "/custom/path" })
    expect(runner.binary).toBe("/custom/path")
  })

  // ── Persistence ──────────────────────────────────────────────────────

  test("persists bindings to disk as JSON array", async () => {
    mod.setSessionRunner("ws_disk", "ses_disk", { type: "claude-acp" })
    const disk = await saved()
    expect(disk.length).toBeGreaterThanOrEqual(1)
    const entry = disk.find((r) => r.workspaceId === "ws_disk" && r.sessionId === "ses_disk")
    expect(entry).toBeDefined()
    expect(entry!.config.runner.type).toBe("claude-acp")
    expect(typeof entry!.updatedAt).toBe("number")
    expect(entry!.updatedAt).toBeGreaterThan(0)
  })
})

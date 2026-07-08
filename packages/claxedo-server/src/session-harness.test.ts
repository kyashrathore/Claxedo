import { describe, expect, test, beforeEach, afterAll } from "vitest"
import { realpathSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"

const root = path.join(realpathSync(os.tmpdir()), `session-harness-test-${randomUUID().slice(0, 8)}`)
const prev = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root

const mod = await import("./session-harness")

function file() {
  return path.join(root, "agent-core", "session-harnesses.json")
}

async function saved() {
  return JSON.parse(await fs.readFile(file(), "utf-8")) as Array<{
    workspaceId: string
    sessionId: string
    config: { harness: { id: string; access: string; connection?: { kind: string; binary?: string } }; model?: { modelID: string } }
    updatedAt: number
  }>
}

function acp(id: "claude" | "codex" | "cursor") {
  return { id, access: "acp" as const }
}

function native(id: "opencode" | "claude" | "codex") {
  return { id, access: "native" as const }
}

function processBinary(input: { connection?: { kind: string; binary?: string } }) {
  return input.connection?.kind === "process" ? input.connection.binary : undefined
}

describe("session harness", () => {
  beforeEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true })
    process.env.CLAXEDO_DATA_DIR = prev
  })

  // ── set / get ────────────────────────────────────────────────────────

  test("stores and retrieves a runner binding for a workspace+session pair", () => {
    mod.setSessionHarness("ws_1", "ses_1", acp("claude"))
    const runner = mod.getSessionHarness("ws_1", "ses_1")
    expect(runner).toBeDefined()
    expect(runner).toMatchObject(acp("claude"))
    expect(processBinary(runner!)).toBeTruthy() // binary is auto-inferred
  })

  test("returns undefined for unbound session", () => {
    const runner = mod.getSessionHarness("ws_missing", "ses_missing")
    expect(runner).toBeUndefined()
  })

  test("overwrites previous binding on re-set", () => {
    mod.setSessionHarness("ws_2", "ses_2", acp("claude"))
    mod.setSessionHarness("ws_2", "ses_2", acp("codex"))
    const runner = mod.getSessionHarness("ws_2", "ses_2")
    expect(runner).toMatchObject(acp("codex"))
  })

  test("isolates bindings between different sessions in the same workspace", () => {
    mod.setSessionHarness("ws_3", "ses_a", acp("claude"))
    mod.setSessionHarness("ws_3", "ses_b", native("opencode"))

    expect(mod.getSessionHarness("ws_3", "ses_a")).toMatchObject(acp("claude"))
    expect(mod.getSessionHarness("ws_3", "ses_b")).toMatchObject(native("opencode"))
  })

  test("isolates bindings between different workspaces with the same session id", () => {
    mod.setSessionHarness("ws_a", "ses_same", acp("claude"))
    mod.setSessionHarness("ws_b", "ses_same", acp("cursor"))

    expect(mod.getSessionHarness("ws_a", "ses_same")).toMatchObject(acp("claude"))
    expect(mod.getSessionHarness("ws_b", "ses_same")).toMatchObject(acp("cursor"))
  })

  // ── delete ───────────────────────────────────────────────────────────

  test("removes a binding and subsequent get returns undefined", () => {
    mod.setSessionHarness("ws_del", "ses_del", acp("codex"))
    mod.deleteSessionHarness("ws_del", "ses_del")
    expect(mod.getSessionHarness("ws_del", "ses_del")).toBeUndefined()
  })

  test("delete of nonexistent binding is a no-op", () => {
    // should not throw
    mod.deleteSessionHarness("ws_noop", "ses_noop")
  })

  // ── listSessionHarnesses ───────────────────────────────────────────────

  test("lists only runners for the specified workspace", () => {
    mod.setSessionHarness("ws_list", "ses_1", acp("claude"))
    mod.setSessionHarness("ws_list", "ses_2", acp("codex"))
    mod.setSessionHarness("ws_other", "ses_3", native("opencode"))

    const list = mod.listSessionHarnesses("ws_list")
    expect(list).toHaveLength(2)
    expect(list.every((row) => row.workspaceId === "ws_list")).toBe(true)
    const ids = list.map((row) => `${row.harness.id}:${row.harness.access}`).sort()
    expect(ids).toEqual(["claude:acp", "codex:acp"])
  })

  test("returns empty list for workspace with no bindings", () => {
    expect(mod.listSessionHarnesses("ws_empty_" + randomUUID())).toEqual([])
  })

  // ── normalize ────────────────────────────────────────────────────────

  test("normalize infers binary for acp types", () => {
    const runner = mod.normalize(acp("claude"))
    expect(runner).toMatchObject(acp("claude"))
    expect(processBinary(runner)).toBeTruthy()
    expect(typeof processBinary(runner)).toBe("string")
  })

  test("normalize returns opencode type without binary", () => {
    const runner = mod.normalize(native("opencode"))
    expect(runner).toMatchObject(native("opencode"))
    expect(processBinary(runner)).toBeUndefined()
  })

  test("normalize preserves raw provider runners without forcing ACP binaries", () => {
    expect(mod.normalize(native("claude"))).toEqual(native("claude"))
    expect(mod.normalize(native("codex"))).toEqual(native("codex"))
  })

  test("normalize preserves explicit binary", () => {
    const runner = mod.normalize({ ...acp("codex"), connection: { kind: "process", binary: "/custom/path" } })
    expect(processBinary(runner)).toBe("/custom/path")
  })

  test("normalize preserves ACP remote transport fields", () => {
    expect(mod.normalize({
      ...acp("claude"),
      connection: {
        kind: "remote",
        transport: "streamable-http",
        url: "http://127.0.0.1:7331/acp",
        headers: { Authorization: "Bearer test-token" },
      },
    })).toMatchObject({
      ...acp("claude"),
      connection: {
        kind: "remote",
        transport: "streamable-http",
        url: "http://127.0.0.1:7331/acp",
        headers: { Authorization: "Bearer test-token" },
      },
    })
  })

  // ── Persistence ──────────────────────────────────────────────────────

  test("persists bindings to disk as JSON array", async () => {
    mod.setSessionHarness("ws_disk", "ses_disk", acp("claude"))
    const disk = await saved()
    expect(disk.length).toBeGreaterThanOrEqual(1)
    const entry = disk.find((r) => r.workspaceId === "ws_disk" && r.sessionId === "ses_disk")
    expect(entry).toBeDefined()
    expect(entry!.config.harness).toMatchObject(acp("claude"))
    expect(typeof entry!.updatedAt).toBe("number")
    expect(entry!.updatedAt).toBeGreaterThan(0)
  })
})

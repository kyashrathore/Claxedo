import { describe, expect, test, beforeEach, afterAll, afterEach, vi } from "vitest"
import { realpathSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"

const root = path.join(realpathSync(os.tmpdir()), `session-harness-test-${randomUUID().slice(0, 8)}`)
const prev = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root

const mod = await import("./index")

function file() {
  return path.join(root, "agent-core", "session-harnesses.json")
}

async function saved() {
  return JSON.parse(await fs.readFile(file(), "utf-8")) as Array<{
    workspaceId: string
    sessionId: string
    config: { harness: { id: string; access: string }; model?: { modelID: string } }
    updatedAt: number
  }>
}

function connection(id: string) {
  return { id, access: "connection" as const }
}

function native(id: "claude" | "codex") {
  return { id, access: "native" as const }
}

describe("session harness", () => {
  beforeEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true })
    if (prev === undefined) delete process.env.CLAXEDO_DATA_DIR
    else process.env.CLAXEDO_DATA_DIR = prev
  })

  // ── set / get ────────────────────────────────────────────────────────

  test("stores and retrieves a runner binding for a workspace+session pair", () => {
    mod.setSessionHarness("ws_1", "ses_1", connection("team-agent"))
    const runner = mod.getSessionHarness("ws_1", "ses_1")
    expect(runner).toBeDefined()
    expect(runner).toEqual(connection("team-agent"))
  })

  test("returns undefined for unbound session", () => {
    const runner = mod.getSessionHarness("ws_missing", "ses_missing")
    expect(runner).toBeUndefined()
  })

  test("overwrites previous binding on re-set", () => {
    mod.setSessionHarness("ws_2", "ses_2", connection("agent-one"))
    mod.setSessionHarness("ws_2", "ses_2", connection("agent-two"))
    const runner = mod.getSessionHarness("ws_2", "ses_2")
    expect(runner).toMatchObject(connection("agent-two"))
  })

  test("isolates bindings between different sessions in the same workspace", () => {
    mod.setSessionHarness("ws_3", "ses_a", connection("team-agent"))
    mod.setSessionHarness("ws_3", "ses_b", native("codex"))

    expect(mod.getSessionHarness("ws_3", "ses_a")).toMatchObject(connection("team-agent"))
    expect(mod.getSessionHarness("ws_3", "ses_b")).toMatchObject(native("codex"))
  })

  test("isolates bindings between different workspaces with the same session id", () => {
    mod.setSessionHarness("ws_a", "ses_same", connection("agent-a"))
    mod.setSessionHarness("ws_b", "ses_same", connection("agent-b"))

    expect(mod.getSessionHarness("ws_a", "ses_same")).toMatchObject(connection("agent-a"))
    expect(mod.getSessionHarness("ws_b", "ses_same")).toMatchObject(connection("agent-b"))
  })

  // ── delete ───────────────────────────────────────────────────────────

  test("removes a binding and subsequent get returns undefined", () => {
    mod.setSessionHarness("ws_del", "ses_del", connection("agent-delete"))
    mod.deleteSessionHarness("ws_del", "ses_del")
    expect(mod.getSessionHarness("ws_del", "ses_del")).toBeUndefined()
  })

  test("delete of nonexistent binding is a no-op", () => {
    // should not throw
    mod.deleteSessionHarness("ws_noop", "ses_noop")
  })

  // ── listSessionHarnesses ───────────────────────────────────────────────

  test("lists only runners for the specified workspace", () => {
    mod.setSessionHarness("ws_list", "ses_1", connection("agent-one"))
    mod.setSessionHarness("ws_list", "ses_2", connection("agent-two"))
    mod.setSessionHarness("ws_other", "ses_3", native("codex"))

    const list = mod.listSessionHarnesses("ws_list")
    expect(list).toHaveLength(2)
    expect(list.every((row) => row.workspaceId === "ws_list")).toBe(true)
    const ids = list.map((row) => `${row.harness.id}:${row.harness.access}`).sort()
    expect(ids).toEqual(["agent-one:connection", "agent-two:connection"])
  })

  test("returns empty list for workspace with no bindings", () => {
    expect(mod.listSessionHarnesses("ws_empty_" + randomUUID())).toEqual([])
  })

  // ── normalize ────────────────────────────────────────────────────────

  test("normalize preserves the configured connection identity", () => {
    const runner = mod.normalize(connection("team-agent"))
    expect(runner).toEqual(connection("team-agent"))
  })

  test("normalize preserves native SDK harnesses", () => {
    expect(mod.normalize(native("claude"))).toEqual(native("claude"))
    expect(mod.normalize(native("codex"))).toEqual(native("codex"))
  })

  // ── Persistence ──────────────────────────────────────────────────────

  test("persists bindings to disk as JSON array", async () => {
    mod.setSessionHarness("ws_disk", "ses_disk", connection("team-agent"))
    const disk = await saved()
    expect(disk.length).toBeGreaterThanOrEqual(1)
    const entry = disk.find((r) => r.workspaceId === "ws_disk" && r.sessionId === "ses_disk")
    expect(entry).toBeDefined()
    expect(entry!.config.harness).toMatchObject(connection("team-agent"))
    expect(typeof entry!.updatedAt).toBe("number")
    expect(entry!.updatedAt).toBeGreaterThan(0)
  })

  test("does not adopt legacy top-level harness session rows", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 60_001)
    await fs.mkdir(path.dirname(file()), { recursive: true })
    await fs.writeFile(file(), JSON.stringify([{
      workspaceId: "ws_legacy",
      sessionId: "ses_legacy",
      harness: connection("team-agent"),
      updatedAt: Date.now(),
    }]))

    expect(mod.getSessionHarness("ws_legacy", "ses_legacy")).toBeUndefined()
  })

  test("keeps the last-known-good cache when a TTL refresh reads malformed JSON", async () => {
    const currentTime = Date.now()
    vi.useFakeTimers()
    vi.setSystemTime(currentTime)
    mod.setSessionHarness("ws_refresh", "ses_refresh", connection("team-agent"))
    await fs.writeFile(file(), "{incomplete", "utf8")

    vi.advanceTimersByTime(60_001)

    expect(mod.getSessionHarness("ws_refresh", "ses_refresh")).toMatchObject(connection("team-agent"))
  })
})

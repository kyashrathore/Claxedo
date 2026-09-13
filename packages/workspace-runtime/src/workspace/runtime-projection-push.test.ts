import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createWorkspaceRuntimeApp } from "../server"
import { createWorkspaceHost } from "./runtime"
import { loopbackWorkspaceRuntimeExposure } from "../exposure"
import type { RuntimeSnapshot } from "../routes/config"

/**
 * What a config push leaves the harness holding.
 *
 * The snapshot keys its projections by registry provider id (`cursor-sdk`,
 * `claude-sdk`, `codex-app-server`) and every driver's `applyConfig` reads them
 * that way. A second, slot-shaped path beside it can only disagree, and when it
 * disagrees the harness runs on whatever login the machine holds — which is the
 * one outcome the operator's account selection exists to prevent.
 *
 * Cursor is the readable one: its backend URL is a process environment
 * variable the driver writes when the config is applied.
 */
const BACKEND_URL = "CURSOR_BACKEND_URL"
const previousBackendUrl = process.env[BACKEND_URL]
let directory = ""

function snapshot(overrides: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot {
  return {
    version: 4,
    mcp: {},
    connections: [],
    auth: {
      "cursor-sdk": {
        baseUrl: "http://127.0.0.1:2595/bindings/cursor1",
        placeholder: "cursor-placeholder",
        authMode: "bearer",
        expiresAt: Date.now() + 60 * 60 * 1000,
      },
    },
    ...overrides,
  }
}

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-projection-"))
  delete process.env[BACKEND_URL]
})

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true })
  if (previousBackendUrl === undefined) delete process.env[BACKEND_URL]
  else process.env[BACKEND_URL] = previousBackendUrl
})

test("a push that selects no harness leaves the live adapter's binding alone", async () => {
  const runtime = createWorkspaceRuntimeApp({
    target: { workspaceId: "ws_1", directory },
    storeRoot: directory,
    exposure: loopbackWorkspaceRuntimeExposure(),
  })
  try {
    await runtime.host.apply(snapshot({ defaultHarness: { kind: "native", harnessId: "cursor" } }))
    expect(process.env[BACKEND_URL]).toBe("http://127.0.0.1:2595/bindings/cursor1")

    // Same projections, no harness named. The adapter is still live and still
    // bound; nothing here says otherwise.
    await runtime.host.apply(snapshot())

    expect(process.env[BACKEND_URL]).toBe("http://127.0.0.1:2595/bindings/cursor1")
  } finally {
    await runtime.host.dispose()
  }
})

test("a push the harness rejects leaves the binding it was already running on", async () => {
  const runtime = createWorkspaceRuntimeApp({
    target: { workspaceId: "ws_1", directory },
    storeRoot: directory,
    exposure: loopbackWorkspaceRuntimeExposure(),
  })
  try {
    await runtime.host.apply(snapshot({ defaultHarness: { kind: "native", harnessId: "cursor" } }))
    expect(process.env[BACKEND_URL]).toBe("http://127.0.0.1:2595/bindings/cursor1")

    const rejected = {
      ...snapshot({ defaultHarness: { kind: "native", harnessId: "cursor" } }),
      auth: { "cursor-sdk": { baseUrl: "", placeholder: "", authMode: "bearer", expiresAt: 0 } },
    } as unknown as RuntimeSnapshot
    await runtime.host.apply(rejected).catch(() => {})

    expect(process.env[BACKEND_URL]).toBe("http://127.0.0.1:2595/bindings/cursor1")
  } finally {
    await runtime.host.dispose()
  }
})

test("a push that selects the harness gives it the projection under its registry id", async () => {
  const runtime = createWorkspaceRuntimeApp({
    target: { workspaceId: "ws_1", directory },
    storeRoot: directory,
    exposure: loopbackWorkspaceRuntimeExposure(),
  })
  try {
    await runtime.host.apply(snapshot({ defaultHarness: { kind: "native", harnessId: "cursor" } }))

    expect(process.env[BACKEND_URL]).toBe("http://127.0.0.1:2595/bindings/cursor1")
  } finally {
    await runtime.host.dispose()
  }
})

test("a configurable adapter is given its projections once, through applyConfig alone", async () => {
  const applied: unknown[] = []
  const slots: unknown[] = []
  const host = createWorkspaceHost({
    target: { workspaceId: "ws_1", directory },
    storeRoot: directory,
    harnesses: [{
      match: (harness: { id: string }) => harness.id === "cursor",
      create: () => ({
        adapterCapabilities: ["runtime-config"] as const,
        setModel() {},
        // A second delivery path for the same fact. It reads the snapshot by
        // harness slot while `applyConfig` reads it by registry provider id,
        // so the two disagree about every brokered account and this one wins
        // whenever `applyConfig` does not run after it.
        setAuth(keys: unknown) { slots.push(keys) },
        async applyConfig(config: unknown) { applied.push(config) },
        sessionConfigOwner: "runtime" as const,
        async createSession(_d: string, _t: string | undefined, id?: string) {
          return { id: id ?? "s1", agentSessionId: "upstream-1" }
        },
        async getSession() { return null },
        async getMessages() { return [] },
        async updateSession() { return null },
        async deleteSession() {},
        async getSessionConfig() { throw new Error("runtime-owned config") },
        async updateSessionConfig() { throw new Error("runtime-owned config") },
        readHarnessCapabilities: () => ({
          abort: false, reconnect: false, replay: true, permissions: false, questions: false,
          todos: false, commands: false, fork: false, revert: false, unrevert: false,
          configOptions: false, subagents: false, goals: false, harness: "cursor",
        }),
        async *executeTurn() {},
        dispose() {},
      }),
    }] as never,
  })
  try {
    await host.apply(snapshot({ defaultHarness: { kind: "native", harnessId: "cursor" } }))

    expect(applied.length).toBeGreaterThan(0)
    for (const config of applied) {
      expect((config as { auth: Record<string, unknown> }).auth).toHaveProperty("cursor-sdk")
    }
    expect(slots).toEqual([])
  } finally {
    await host.dispose()
  }
})

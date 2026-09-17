/**
 * Terminal Clone Recovery Tests
 *
 * Tests for the clone-on-reconnect flow where stale PTYs are replaced
 * by cloning them with a new server-side process.
 */
import { afterAll, describe, expect, test, beforeEach, mock } from "bun:test"
import { createRoot } from "solid-js"
import { createMockSDK, createMockStorage, createTerminalApiModule, installFetchMock } from "./test-support/terminal-fixture"

// ---------------------------------------------------------------------------
// Register mocks
// ---------------------------------------------------------------------------

const storage = createMockStorage()
const realApiModule = { ...(await import(`${import.meta.dir}/../../../platform/api/api.ts?clone-recovery-restore`)) }
const realPersistModule = { ...(await import(`${import.meta.dir}/../../../platform/persistence/persist.ts?clone-recovery-restore`)) }
const realRouterModule = { ...(await import("@solidjs/router")) }

// `mock.module` returns a promise; awaiting it means the hook does not resolve
// until the module graph has actually been swapped back, so a later file in the
// same process cannot observe a half-restored module.
afterAll(async () => {
  await mock.module("@/platform/api/api", () => realApiModule)
  await mock.module("@/platform/persistence/persist", () => realPersistModule)
  await mock.module("@solidjs/router", () => realRouterModule)
})

await mock.module("@opencode-ai/ui/context", () => ({
  createSimpleContext: () => ({ use: () => {}, provider: () => {} }),
}))

await mock.module("@/app/providers/sdk/sdk", () => ({
  useSDK: () => { throw new Error("useSDK called outside test") },
}))

await mock.module("@/platform/api/api", () => createTerminalApiModule("http://127.0.0.1:3001"))

// Spread the real module: `mock.module` replaces the module PROCESS-WIDE, so a
// partial mock would break later files that import its other exports.
await mock.module("@/platform/persistence/persist", () => ({
  ...realPersistModule,
  Persist: {
    ...realPersistModule.Persist,
    scoped: (dir: string, session: string | undefined, key: string, legacy?: string[]) => ({
      storage: "test.dat",
      key: session ? `${dir}:session:${session}:${key}` : `${dir}:workspace:${key}`,
      legacy,
    }),
    workspace: (dir: string, key: string, legacy?: string[]) => ({
      storage: "test.dat",
      key: `${dir}:workspace:${key}`,
      legacy,
    }),
    serverWorkspace: (url: string, dir: string, key: string, legacy?: string[]) => ({
      storage: "test.dat",
      key: `${dir}:workspace:${key}`,
      legacy,
    }),
  },
  persisted: (_target: any, storeResult: any) => {
    const [state, setState] = storeResult
    const key = typeof _target === "string" ? _target : _target.key

    const raw = storage.getItem(key)
    if (raw) {
      try {
        const parsed = JSON.parse(raw)
        setState("all", parsed.all ?? [])
        if (parsed.active !== undefined) setState("active", parsed.active)
      } catch {}
    }

    const persistingSet = (...args: any[]) => {
      setState(...args)
      const snapshot = JSON.parse(JSON.stringify({ all: state.all, active: state.active }))
      storage.setItem(key, JSON.stringify(snapshot))
    }

    return [state, persistingSet, null, () => true]
  },
  removePersisted: () => Promise.resolve(),
}))

await mock.module("@solidjs/router", () => ({
  useParams: () => ({ dir: "/workspace" }),
}))



const { createTerminalSession } = await import("@/features/terminal/providers/provider")

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tick() {
  return new Promise<void>((r) => setTimeout(r, 0))
}

function createSession(
  sdk: ReturnType<typeof createMockSDK>,
  input?: {
    dir?: string
  },
) {
  let session: ReturnType<typeof createTerminalSession>
  let dispose: () => void
  createRoot((d) => {
    dispose = d
    session = createTerminalSession(sdk, input?.dir ?? "/workspace", {
      claxedoEvents: sdk.claxedoEvents,
      claxedoServerUrl: "http://127.0.0.1:3001",
    })
  })
  return { session: session!, dispose: dispose! }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("terminal clone recovery on app restart", () => {
  beforeEach(() => {
    storage.clear()
  })

  test("clone() returns the new PTY ID", async () => {
    const sdk = createMockSDK()
    const restoreFetch = installFetchMock(sdk)
    const { session, dispose } = createSession(sdk)

    await session.new()
    await tick()

    const all = session.all()
    expect(all).toHaveLength(1)
    const oldId = all[0].id

    const newId = await session.clone(oldId)
    await tick()

    expect(newId).toBeDefined()
    expect(typeof newId).toBe("string")
    expect(newId).not.toBe(oldId)
    expect(session.all()[0].id).toBe(newId)

    dispose()
    restoreFetch()
  })

  test("clone() discards the old stream checkpoint so the host can restore history", async () => {
    const sdk = createMockSDK()
    const restoreFetch = installFetchMock(sdk)
    const { session, dispose } = createSession(sdk)

    await session.new()
    await tick()

    const oldId = session.all()[0].id
    // Set buffer and cursor on the PTY entry
    session.update({ id: oldId, buffer: "hello", cursor: 3_200_000, cols: 100, rows: 30,
      modeSequences: "\x1b[?2004h", wasAltScreen: true, wasAtBottom: false, scrollY: 20 })
    await tick()

    const newId = await session.clone(oldId)
    await tick()

    expect(newId).toBeDefined()
    const entry = session.all()[0]
    expect(entry.id).toBe(newId)
    expect(entry.buffer).toBeUndefined()
    expect(entry.cursor).toBeUndefined()
    expect(entry.modeSequences).toBeUndefined()
    expect(entry.wasAltScreen).toBeUndefined()
    expect(entry.wasAtBottom).toBeUndefined()
    expect(entry.scrollY).toBeUndefined()

    dispose()
    restoreFetch()
  })

  test("clone() passes previousPtyId to server create call", async () => {
    const sdk = createMockSDK()
    const restoreFetch = installFetchMock(sdk)
    const { session, dispose } = createSession(sdk)

    await session.new()
    await tick()

    const oldId = session.all()[0].id
    const callsBefore = sdk._createCalls.length

    await session.clone(oldId)
    await tick()

    const cloneCall = sdk._createCalls[callsBefore]
    expect(cloneCall).toBeDefined()
    expect(cloneCall.cwd).toBeUndefined()
    expect(cloneCall.env?.previousPtyId).toBe(oldId)
    expect(cloneCall.env?.CLAXEDO_PORT).toBe("3001")
    expect(cloneCall.env?.CLAXEDO_WORKSPACE_ID).toBe("/workspace")

    dispose()
    restoreFetch()
  })

  test("clone() preserves the PTY cwd instead of falling back to sdk.directory", async () => {
    const sdk = createMockSDK()
    sdk.directory = "/workspace/fallback"
    const restoreFetch = installFetchMock(sdk)
    const { session, dispose } = createSession(sdk, { dir: "/workspace" })

    await session.new()
    await tick()

    const oldId = session.all()[0].id
    session.update({ id: oldId, cwd: "/workspace/project-a" })
    await tick()

    const callsBefore = sdk._createCalls.length

    await session.clone(oldId)
    await tick()

    const cloneCall = sdk._createCalls[callsBefore]
    expect(cloneCall).toBeDefined()
    expect(cloneCall.cwd).toBe("project-a")
    expect(cloneCall.env?.CLAXEDO_WORKSPACE_ID).toBe("/workspace")

    dispose()
    restoreFetch()
  })

  test("ensure() lets a missing restored PTY recover through clone()", async () => {
    const sdk = createMockSDK()
    const restoreFetch = installFetchMock(sdk)
    const { session, dispose } = createSession(sdk, { dir: "/workspace" })

    session.ensure({
      id: "pty-stale",
      title: "Codex 7",
      cwd: "/workspace/project-a",
      initialCommand: "codex",
    })
    await tick()

    expect(session.all().map((item) => item.id)).toContain("pty-stale")

    const callsBefore = sdk._createCalls.length
    const newId = await session.clone("pty-stale")
    await tick()

    expect(newId).toBeDefined()
    expect(newId).not.toBe("pty-stale")
    const cloneCall = sdk._createCalls[callsBefore]
    expect(cloneCall).toBeDefined()
    expect(cloneCall.cwd).toBe("project-a")
    expect(cloneCall.env?.previousPtyId).toBe("pty-stale")
    expect(session.all()[0]?.id).toBe(newId)

    dispose()
    restoreFetch()
  })

  test("clone() preserves cloud workspace routing when dir differs from cwd", async () => {
    const sdk = createMockSDK()
    sdk.directory = "/Users/yash/worktrees/local-mirror"
    const restoreFetch = installFetchMock(sdk)
    const { session, dispose } = createSession(sdk, { dir: "ws_cloud_123" })

    await session.new()
    await tick()

    const oldId = session.all()[0].id
    session.update({ id: oldId, cwd: "/workspaces/cloud/app" })
    await tick()

    const callsBefore = sdk._createCalls.length

    await session.clone(oldId)
    await tick()

    const cloneCall = sdk._createCalls[callsBefore]
    expect(cloneCall).toBeDefined()
    expect(cloneCall.cwd).toBe("/workspaces/cloud/app")
    expect(cloneCall.env?.previousPtyId).toBe(oldId)
    expect(cloneCall.env?.CLAXEDO_WORKSPACE_ID).toBe("ws_cloud_123")

    dispose()
    restoreFetch()
  })

  test("clone() keeps persisted cwd after reload before recovery", async () => {
    const sdk = createMockSDK()
    sdk.directory = "/workspace/fallback"
    const restoreFetch = installFetchMock(sdk)
    const { session, dispose } = createSession(sdk, { dir: "ws_cloud_123" })

    await session.new()
    await tick()

    const oldId = session.all()[0].id
    session.update({
      id: oldId,
      cwd: "/workspaces/cloud/app",
      modeSequences: "\x1b[?2004h",
      wasAltScreen: true,
      wasAtBottom: true,
      initialCommand: "codex",
    })
    await tick()

    dispose()

    const { session: reloaded, dispose: dispose2 } = createSession(sdk, { dir: "ws_cloud_123" })
    await tick()
    await tick()

    expect(reloaded.all()[0]?.cwd).toBe("/workspaces/cloud/app")
    expect(reloaded.all()[0]?.modeSequences).toBe("\x1b[?2004h")
    expect(reloaded.all()[0]?.wasAltScreen).toBe(true)
    expect(reloaded.all()[0]?.wasAtBottom).toBe(true)
    expect(reloaded.all()[0]?.initialCommand).toBe("codex")

    const callsBefore = sdk._createCalls.length

    await reloaded.clone(oldId)
    await tick()

    const cloneCall = sdk._createCalls[callsBefore]
    expect(cloneCall).toBeDefined()
    expect(cloneCall.cwd).toBe("/workspaces/cloud/app")
    expect(cloneCall.env?.CLAXEDO_WORKSPACE_ID).toBe("ws_cloud_123")

    dispose2()
    restoreFetch()
  })

  test("stale PTY persists in store until onConnectError triggers clone", async () => {
    const sdk = createMockSDK()
    const restoreFetch = installFetchMock(sdk)
    const { session, dispose } = createSession(sdk)

    // Create a terminal
    await session.new()
    await tick()
    const oldId = session.all()[0].id

    // Simulate "reload" - dispose old session, server forgets PTY
    dispose()
    sdk._serverPtys.delete(oldId)

    // New session reads from same storage
    const { session: reloaded, dispose: dispose2 } = createSession(sdk)
    await tick()
    await tick()

    // Key assertion: stale PTY should STILL be in store (not pruned)
    // The reconciliation effect has been removed — store is not preemptively cleared
    // Recovery happens via onConnectError → clone() flow instead
    expect(reloaded.all()).toHaveLength(1)
    expect(reloaded.all()[0].id).toBe(oldId)

    dispose2()
    restoreFetch()
  })
})

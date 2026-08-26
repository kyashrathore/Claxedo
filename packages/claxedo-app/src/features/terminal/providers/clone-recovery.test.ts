/**
 * Terminal Clone Recovery Tests
 *
 * Tests for the clone-on-reconnect flow where stale PTYs are replaced
 * by cloning them with a new server-side process.
 */
import { afterAll, describe, expect, test, beforeEach, mock } from "bun:test"
import { createRoot, snapshot, storePath } from "solid-js"
import { createMockSDK, createMockStorage, installFetchMock } from "./test-helpers"

// ---------------------------------------------------------------------------
// Register mocks
// ---------------------------------------------------------------------------

const storage = createMockStorage()
const realApiModule = { ...(await import(`${import.meta.dir}/../../../platform/api/api.ts?clone-recovery-restore`)) }
const realPersistModule = {
  ...(await import(`${import.meta.dir}/../../../platform/persistence/persist.ts?clone-recovery-restore`)),
}
const realRouterModule = { ...(await import("@solidjs/router")) }
const realRecoveryModule = {
  ...(await import(`${import.meta.dir}/../core/terminal-recovery.ts?clone-recovery-restore`)),
}

afterAll(() => {
  mock.module("@/platform/api/api", () => realApiModule)
  mock.module("@/platform/persistence/persist", () => realPersistModule)
  mock.module("@solidjs/router", () => realRouterModule)
  mock.module("@/features/terminal/core/terminal-recovery", () => realRecoveryModule)
})

mock.module("@opencode-ai/ui/context", () => ({
  createSimpleContext: () => ({ use: () => {}, provider: () => {} }),
}))

mock.module("@/app/providers/sdk/sdk", () => ({
  useSDK: () => {
    throw new Error("useSDK called outside test")
  },
}))

mock.module("@/platform/api/api", () => ({
  authFetch: (input: string | URL | Request, init?: RequestInit) => fetch(input, init),
  getClaxedoServerUrl: () => "http://127.0.0.1:3001",
  getDefaultBaseUrl: () => "http://127.0.0.1:3001",
  // Stub remaining api.ts exports — see terminal-relay-lifecycle.test.ts
  api: {} as Record<string, unknown>,
  isDemoMode: () => false,
  isDemoPath: () => false,
  isEmbedMode: () => false,
  fixDir: (input: string | undefined) => input,
  configureApiRuntime: () => undefined,
  resetApiRuntime: () => undefined,
  normalizeUrl: (u: string | undefined) => u?.trim().replace(/\/+$/, "") || undefined,
}))

// Spread the real module: `mock.module` replaces the module PROCESS-WIDE, so a
// partial mock would break later files that import its other exports.
mock.module("@/platform/persistence/persist", () => ({
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
        // `storePath(...)`, not Solid 1's `setState(key, value)` path form —
        // Solid 2's setter takes a draft callback or a `storePath` write and
        // silently does nothing with a bare path argument list.
        setState(storePath("all", parsed.all ?? []))
        if (parsed.active !== undefined) setState(storePath("active", parsed.active))
      } catch {}
    }

    const persistingSet = (...args: any[]) => {
      setState(...args)
      // `snapshot()`, not a read of `state`. Solid 2 stages the write until the
      // scheduler flushes, so reading the store here persists the value from
      // BEFORE the mutation — one step behind, forever. Real `makePersisted`
      // serializes `snapshot(store)` for exactly this reason.
      const persisted = snapshot(state) as { all: unknown; active: unknown }
      storage.setItem(key, JSON.stringify({ all: persisted.all, active: persisted.active }))
    }

    return [state, persistingSet, null, () => true]
  },
  removePersisted: () => Promise.resolve(),
}))

mock.module("@solidjs/router", () => ({
  useParams: () => ({ dir: "/workspace" }),
}))

mock.module("@/features/terminal/core/terminal-recovery", () => {
  const executed = new Set<string>()
  const claimed = new Set<string>()
  const initialCommandKey = (id: string) => `opencode.pty.${id}.initial-command-ran`
  return {
    clearInitialCommandMarker: (id: string) => {
      executed.delete(id)
      claimed.delete(id)
    },
    markInitialCommandRan: (id: string) => {
      executed.add(id)
      claimed.delete(id)
    },
    shouldRunInitialCommand: (pty: { id: string; initialCommand?: string }) => {
      if (!pty.initialCommand) return false
      if (executed.has(pty.id)) return false
      if (claimed.has(pty.id)) return false
      return true
    },
    claimInitialCommand: (pty: { id: string; initialCommand?: string }) => {
      if (!pty.initialCommand || executed.has(pty.id) || claimed.has(pty.id)) return false
      claimed.add(pty.id)
      return true
    },
    releaseInitialCommandClaim: (id: string) => {
      claimed.delete(id)
    },
    initialCommandKey,
  }
})

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

  test("clone() preserves buffer and cursor from old entry", async () => {
    const sdk = createMockSDK()
    const restoreFetch = installFetchMock(sdk)
    const { session, dispose } = createSession(sdk)

    await session.new()
    await tick()

    const oldId = session.all()[0].id
    // Set buffer and cursor on the PTY entry
    session.update({ id: oldId, buffer: "hello", cursor: 5 })
    await tick()

    const newId = await session.clone(oldId)
    await tick()

    expect(newId).toBeDefined()
    const entry = session.all()[0]
    expect(entry.id).toBe(newId)
    expect(entry.buffer).toBe("hello")
    expect(entry.cursor).toBe(5)

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

/**
 * Terminal persistence behavior tests
 *
 * Strategy: mock the SDK, persisted storage, and SolidJS context dependencies,
 * then exercise createTerminalSession directly. "Reload" is simulated by
 * creating a new session that reads from the same in-memory storage.
 */
import { afterAll, describe, expect, test, beforeEach, mock } from "bun:test"
import { createRoot } from "solid-js"
import { createMockSDK, createMockStorage, installFetchMock } from "./test-helpers"

const RAW_SCOPE = "/workspace"
const LEGACY_SCOPE = "L3dvcmtzcGFjZQ"
const CURRENT_KEY = `${RAW_SCOPE}:workspace:terminal.v2`
const LEGACY_V2_KEY = `${LEGACY_SCOPE}:workspace:terminal.v2`
const LEGACY_KEY = `${RAW_SCOPE}:workspace:terminal`

// ---------------------------------------------------------------------------
// Register mocks before importing the module under test
// ---------------------------------------------------------------------------

const storage = createMockStorage()
const realApiModule = { ...(await import(`${import.meta.dir}/../../../platform/api/api.ts?zombie-restore`)) }
const realPersistModule = { ...(await import(`${import.meta.dir}/../../../platform/persistence/persist.ts?zombie-restore`)) }

afterAll(() => {
  mock.module("@/platform/api/api", () => realApiModule)
  mock.module("@/platform/persistence/persist", () => realPersistModule)
})

// Mock persisted() to use our in-memory storage instead of localStorage
mock.module("@opencode-ai/ui/context", () => ({
  createSimpleContext: () => ({ use: () => {}, provider: () => {} }),
}))

mock.module("@/app/providers/sdk/sdk", () => ({
  useSDK: () => { throw new Error("useSDK called outside test") },
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
    serverWorkspace: (url: string, dir: string, key: string, legacy?: string[]) => ({
      storage: "test.dat",
      key: `${dir}:workspace:${key}`,
      legacy,
    }),
  },
  persisted: (_target: any, storeResult: any) => {
    const [state, setState] = storeResult
    const key = typeof _target === "string" ? _target : _target.key

    // Hydrate from storage on init (simulates page load)
    const raw = storage.getItem(key)
    if (raw) {
      try {
        const parsed = JSON.parse(raw)
        // Use reconcile-like behavior: replace the store contents
        setState("all", parsed.all ?? [])
        if (parsed.active !== undefined) setState("active", parsed.active)
      } catch {}
    }

    // Wrap setState to persist on every mutation
    const persistingSet = (...args: any[]) => {
      setState(...args)
      // Read current state and persist
      const snapshot = JSON.parse(JSON.stringify({ all: state.all, active: state.active }))
      storage.setItem(key, JSON.stringify(snapshot))
    }

    return [state, persistingSet, null, () => true]
  },
  removePersisted: (target: { key: string }) => {
    storage.removeItem(target.key)
    return Promise.resolve()
  },
}))

mock.module("@/features/terminal/core/terminal-recovery", () => {
  const executed = new Set<string>()
  const claimed = new Set<string>()
  const initialCommandKey = (id: string) => `opencode.pty.${id}.initial-command-ran`
  return {
    clearInitialCommandMarker: (id: string) => {
      executed.delete(id)
      claimed.delete(id)
      if (typeof localStorage !== "undefined") localStorage.removeItem(initialCommandKey(id))
    },
    markInitialCommandRan: (id: string) => {
      executed.add(id)
      claimed.delete(id)
      if (typeof localStorage !== "undefined") localStorage.setItem(initialCommandKey(id), "1")
    },
    shouldRunInitialCommand: (pty: { id: string; initialCommand?: string }) => {
      if (!pty.initialCommand) return false
      if (executed.has(pty.id)) return false
      if (claimed.has(pty.id)) return false
      if (typeof localStorage !== "undefined" && localStorage.getItem(initialCommandKey(pty.id))) return false
      return true
    },
    claimInitialCommand: (pty: { id: string; initialCommand?: string }) => {
      if (!pty.initialCommand || executed.has(pty.id) || claimed.has(pty.id)) return false
      claimed.add(pty.id)
      return true
    },
    releaseInitialCommandClaim: (id: string) => { claimed.delete(id) },
    initialCommandKey,
  }
})

// Now import the module under test
const { createTerminalSession } = await import("@/features/terminal/providers/provider")

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tick() {
  return new Promise<void>((r) => setTimeout(r, 0))
}

function createSession(sdk: ReturnType<typeof createMockSDK>) {
  let session: ReturnType<typeof createTerminalSession>
  let dispose: () => void
  createRoot((d) => {
    dispose = d
    session = createTerminalSession(sdk, "/workspace")
  })
  return { session: session!, dispose: dispose! }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("terminal persistence behavior", () => {
  beforeEach(() => {
    storage.clear()
  })

  describe("close flow", () => {
    test("closing a terminal before create .then() resolves should not re-add it", async () => {
      const sdk = createMockSDK()
      const restoreFetch = installFetchMock(sdk)
      const { session, dispose } = createSession(sdk)

      // Create a terminal
      await session.new()
      await tick()

      const all = session.all()
      expect(all).toHaveLength(1)
      const ptyId = all[0].id

      // Close the terminal
      await session.close(ptyId)
      await tick()

      expect(session.all()).toHaveLength(0)

      // Simulate "reload" — create new session reading from same storage
      dispose()
      const { session: session2, dispose: dispose2 } = createSession(sdk)

      // After reload, store should be empty — no zombie
      expect(session2.all()).toHaveLength(0)

      dispose2()
      restoreFetch()
    })
  })

  describe("reload behavior", () => {
    test("store.all should be empty after close() even without close watcher", async () => {
      const sdk = createMockSDK()
      const restoreFetch = installFetchMock(sdk)
      const { session, dispose } = createSession(sdk)

      // Create two terminals (simulates "terminal and terminal inside it")
      await session.new()
      await tick()
      await session.new()
      await tick()

      expect(session.all()).toHaveLength(2)
      const ids = session.all().map((p) => p.id)

      // Close both
      await session.close(ids[0])
      await session.close(ids[1])
      await tick()

      expect(session.all()).toHaveLength(0)

      // Verify storage is clean
      const raw = storage.getItem(CURRENT_KEY)
      if (raw) {
        const parsed = JSON.parse(raw)
        expect(parsed.all).toHaveLength(0)
      }

      dispose()
      restoreFetch()
    })

    test("after reload, closed terminals should not reappear in store.all", async () => {
      const sdk = createMockSDK()
      const restoreFetch = installFetchMock(sdk)
      const { session, dispose } = createSession(sdk)

      // Create terminals
      await session.new()
      await tick()
      await session.new()
      await tick()
      expect(session.all()).toHaveLength(2)

      // Close all
      for (const pty of session.all()) {
        await session.close(pty.id)
      }
      await tick()
      expect(session.all()).toHaveLength(0)

      // "Reload" — dispose old, create new reading from same storage
      dispose()
      const { session: reloaded, dispose: dispose2 } = createSession(sdk)

      expect(reloaded.all()).toHaveLength(0)

      dispose2()
      restoreFetch()
    })
  })

  describe("persisted key migration", () => {
    test("old base64-scoped terminal.v2 bucket migrates into raw scope when raw scope is empty", async () => {
      const sdk = createMockSDK()
      storage.setItem(
        LEGACY_V2_KEY,
        JSON.stringify({
          all: [
            { id: "pty-old", title: "Terminal 1", titleNumber: 1, cwd: "/workspace" },
          ],
          active: "pty-old",
        }),
      )

      const { session, dispose } = createSession(sdk)
      await tick()
      await tick()

      expect(session.all().map((pty) => pty.id)).toEqual(["pty-old"])
      expect(session.active()).toBe("pty-old")
      expect(storage.getItem(LEGACY_V2_KEY)).toBeNull()
      expect(JSON.parse(storage.getItem(CURRENT_KEY)!).all).toEqual([
        { id: "pty-old", title: "Terminal 1", titleNumber: 1, cwd: "/workspace" },
      ])

      dispose()
    })

    test("old base64-scoped terminal.v2 bucket is not read when raw scope already has terminals", async () => {
      const sdk = createMockSDK()
      storage.setItem(
        CURRENT_KEY,
        JSON.stringify({
          all: [
            { id: "pty-current", title: "Terminal 1", titleNumber: 1, cwd: "/workspace" },
          ],
          active: "pty-current",
        }),
      )
      storage.setItem(
        LEGACY_V2_KEY,
        JSON.stringify({
          all: [
            { id: "pty-old", title: "Terminal 2", titleNumber: 2, cwd: "/workspace" },
          ],
          active: "pty-old",
        }),
      )

      const { session, dispose } = createSession(sdk)
      await tick()
      await tick()

      expect(session.all().map((pty) => pty.id)).toEqual(["pty-current"])
      expect(session.active()).toBe("pty-current")
      expect(storage.getItem(LEGACY_V2_KEY)).toBeTruthy()

      dispose()
    })

    test("legacy persisted key is ignored on reload", async () => {
      const sdk = createMockSDK()

      // Seed legacy key entries from the old model; new model must ignore these.
      storage.setItem(
        LEGACY_KEY,
        JSON.stringify({
          all: [
            { id: "pty-stale-1", title: "Terminal 1", titleNumber: 1, cwd: "/workspace" },
            { id: "pty-stale-2", title: "Terminal 2", titleNumber: 2, cwd: "/workspace" },
            { id: "pty-stale-3", title: "Terminal 3", titleNumber: 3, cwd: "/workspace" },
          ],
          active: "pty-stale-1",
        }),
      )

      const { session, dispose } = createSession(sdk)

      await tick()
      await tick()

      expect(session.all()).toHaveLength(0)

      dispose()
    })

    test("current persisted key is used for reload state", async () => {
      const sdk = createMockSDK()

      // Create a real PTY on the server
      const info = { id: "pty-real", title: "Terminal 1", cwd: "/workspace" }
      sdk._serverPtys.set("pty-real", info)

      // Seed storage with both a real and stale PTY
      storage.setItem(
        CURRENT_KEY,
        JSON.stringify({
          all: [
            { id: "pty-real", title: "Terminal 1", titleNumber: 1, cwd: "/workspace" },
            { id: "pty-ghost", title: "Terminal 2", titleNumber: 2, cwd: "/workspace" },
          ],
          active: "pty-real",
        }),
      )

      const { session, dispose } = createSession(sdk)
      await tick()
      await tick()

      expect(session.all()).toHaveLength(2)
      expect(session.all().map((p) => p.id)).toContain("pty-real")
      expect(session.all().map((p) => p.id)).toContain("pty-ghost")

      dispose()
    })
  })

  describe("disconnected exit events", () => {
    test("PTY that exited while frontend was disconnected remains in current persisted store", async () => {
      const sdk = createMockSDK()
      const restoreFetch = installFetchMock(sdk)
      const { session, dispose } = createSession(sdk)

      // Create a terminal
      await session.new()
      await tick()
      expect(session.all()).toHaveLength(1)
      const ptyId = session.all()[0].id

      // Simulate "disconnect" — unsubscribe all event listeners (page unload)
      dispose()

      // Server kills the PTY while frontend is disconnected
      sdk._serverPtys.delete(ptyId)
      // pty.exited event fires but nobody is listening
      sdk._emit("pty.exited", { id: ptyId, exitCode: 0 })

      // Storage still has the old PTY (persisted before disconnect)
      const raw = storage.getItem(CURRENT_KEY)
      expect(raw).toBeTruthy()
      const parsed = JSON.parse(raw!)
      expect(parsed.all).toHaveLength(1) // stale entry

      // "Reload" — create new session
      const { session: reloaded, dispose: dispose2 } = createSession(sdk)
      await tick()
      await tick()

      expect(reloaded.all()).toHaveLength(1)
      expect(reloaded.all()[0].id).toBe(ptyId)

      dispose2()
      restoreFetch()
    })
  })
})

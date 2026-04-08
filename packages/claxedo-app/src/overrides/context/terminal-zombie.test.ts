/**
 * Terminal persistence behavior tests
 *
 * Strategy: mock the SDK, persisted storage, and SolidJS context dependencies,
 * then exercise createTerminalSession directly. "Reload" is simulated by
 * creating a new session that reads from the same in-memory storage.
 */
import { describe, expect, test, beforeEach, mock } from "bun:test"
import { createRoot, createEffect } from "solid-js"
import { createMockSDK, createMockStorage, installFetchMock } from "./terminal-test-helpers"

const CURRENT_KEY = "workspace:terminal.v2"
const LEGACY_KEY = "workspace:terminal"

// ---------------------------------------------------------------------------
// Register mocks before importing the module under test
// ---------------------------------------------------------------------------

const storage = createMockStorage()

// Mock persisted() to use our in-memory storage instead of localStorage
mock.module("@opencode-ai/ui/context", () => ({
  createSimpleContext: (config: any) => ({ use: () => {}, provider: () => {} }),
}))

mock.module("@/context/sdk", () => ({
  useSDK: () => { throw new Error("useSDK called outside test") },
}))

mock.module("@/utils/persist", () => ({
  Persist: {
    workspace: (dir: string, key: string, legacy?: string[]) => ({
      storage: "test.dat",
      key: `workspace:${key}`,
      legacy,
    }),
    serverWorkspace: (url: string, dir: string, key: string, legacy?: string[]) => ({
      storage: "test.dat",
      key: `workspace:${key}`,
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
      ;(setState as any)(...args)
      // Read current state and persist
      const snapshot = JSON.parse(JSON.stringify({ all: state.all, active: state.active }))
      storage.setItem(key, JSON.stringify(snapshot))
    }

    return [state, persistingSet, null, () => true]
  },
}))

mock.module("../components/terminal-recovery", () => {
  const executed = new Set<string>()
  const initialCommandKey = (id: string) => `opencode.pty.${id}.initial-command-ran`
  return {
    clearInitialCommandMarker: (id: string) => {
      executed.delete(id)
      if (typeof localStorage !== "undefined") localStorage.removeItem(initialCommandKey(id))
    },
    markInitialCommandRan: (id: string) => {
      executed.add(id)
      if (typeof localStorage !== "undefined") localStorage.setItem(initialCommandKey(id), "1")
    },
    shouldRunInitialCommand: (pty: { id: string; initialCommand?: string }) => {
      if (!pty.initialCommand) return false
      if (executed.has(pty.id)) return false
      if (typeof localStorage !== "undefined" && localStorage.getItem(initialCommandKey(pty.id))) return false
      return true
    },
    initialCommandKey,
  }
})

// Now import the module under test
const { createTerminalSession } = await import("./terminal")
const { mergeCreatedTerminal } = await import("./terminal-shared")

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
    session = createTerminalSession(sdk as any, "/workspace")
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
      session.new()
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
      session.new()
      await tick()
      session.new()
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
      session.new()
      await tick()
      session.new()
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
      session.new()
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

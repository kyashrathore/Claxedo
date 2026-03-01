/**
 * Terminal Clone Recovery Tests
 *
 * Tests for the clone-on-reconnect flow where stale PTYs are replaced
 * by cloning them with a new server-side process.
 */
import { describe, expect, test, beforeEach, mock } from "bun:test"
import { createRoot } from "solid-js"

// ---------------------------------------------------------------------------
// Mock infrastructure (same as terminal-zombie.test.ts)
// ---------------------------------------------------------------------------

type Listener = (event: any) => void

function createMockSDK() {
  const listeners = new Map<string, Set<Listener>>()
  const serverPtys = new Map<string, { id: string; title: string; cwd: string }>()
  let nextId = 1
  const createCalls: any[] = []

  return {
    url: "http://localhost:7860",
    directory: "/workspace",
    event: {
      on(type: string, fn: Listener) {
        if (!listeners.has(type)) listeners.set(type, new Set())
        listeners.get(type)!.add(fn)
        return () => listeners.get(type)?.delete(fn)
      },
    },
    client: {
      pty: {
        async create(input: { title?: string; env?: Record<string, string>; previousPtyId?: string }) {
          createCalls.push(input)
          const id = `pty-${nextId++}`
          const info = { id, title: input.title ?? `Terminal ${id}`, cwd: "/workspace" }
          serverPtys.set(id, info)
          emit("pty.created", { info })
          return { data: info }
        },
        async remove(input: { ptyID: string }) {
          const existed = serverPtys.delete(input.ptyID)
          if (existed) emit("pty.deleted", { id: input.ptyID })
        },
        async update(_input: any) {},
        async list() {
          return { data: Array.from(serverPtys.values()) }
        },
      },
    },
    _emit: emit,
    _serverPtys: serverPtys,
    _listeners: listeners,
    _createCalls: createCalls,
  }

  function emit(type: string, properties: any) {
    const fns = listeners.get(type)
    if (!fns) return
    for (const fn of fns) fn({ type, properties })
  }
}

function createMockStorage() {
  const data = new Map<string, string>()
  return {
    data,
    getItem(key: string) { return data.get(key) ?? null },
    setItem(key: string, value: string) { data.set(key, value) },
    removeItem(key: string) { data.delete(key) },
    clear() { data.clear() },
  }
}

// ---------------------------------------------------------------------------
// Register mocks
// ---------------------------------------------------------------------------

const storage = createMockStorage()

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

    const raw = storage.getItem(key)
    if (raw) {
      try {
        const parsed = JSON.parse(raw)
        setState("all", parsed.all ?? [])
        if (parsed.active !== undefined) setState("active", parsed.active)
      } catch {}
    }

    const persistingSet = (...args: any[]) => {
      ;(setState as any)(...args)
      const snapshot = JSON.parse(JSON.stringify({ all: state.all, active: state.active }))
      storage.setItem(key, JSON.stringify(snapshot))
    }

    return [state, persistingSet, null, () => true]
  },
  removePersisted: () => Promise.resolve(),
}))

mock.module("@solidjs/router", () => ({
  useParams: () => ({ dir: "/workspace" }),
}))

mock.module("../components/terminal-recovery", () => {
  const executed = new Set<string>()
  const initialCommandKey = (id: string) => `opencode.pty.${id}.initial-command-ran`
  return {
    clearInitialCommandMarker: (id: string) => { executed.delete(id) },
    markInitialCommandRan: (id: string) => { executed.add(id) },
    shouldRunInitialCommand: (pty: { id: string; initialCommand?: string }) => {
      if (!pty.initialCommand) return false
      if (executed.has(pty.id)) return false
      return true
    },
    initialCommandKey,
  }
})

const { createTerminalSession } = await import("./terminal")

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

describe("terminal clone recovery on app restart", () => {
  beforeEach(() => {
    storage.clear()
  })

  test("clone() returns the new PTY ID", async () => {
    const sdk = createMockSDK()
    const { session, dispose } = createSession(sdk)

    session.new()
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
  })

  test("clone() preserves buffer and cursor from old entry", async () => {
    const sdk = createMockSDK()
    const { session, dispose } = createSession(sdk)

    session.new()
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
  })

  test("clone() passes previousPtyId to server create call", async () => {
    const sdk = createMockSDK()
    const { session, dispose } = createSession(sdk)

    session.new()
    await tick()

    const oldId = session.all()[0].id
    const callsBefore = sdk._createCalls.length

    await session.clone(oldId)
    await tick()

    const cloneCall = sdk._createCalls[callsBefore]
    expect(cloneCall).toBeDefined()
    expect(cloneCall.env?.previousPtyId).toBe(oldId)

    dispose()
  })

  test("stale PTY persists in store until onConnectError triggers clone", async () => {
    const sdk = createMockSDK()
    const { session, dispose } = createSession(sdk)

    // Create a terminal
    session.new()
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
  })
})

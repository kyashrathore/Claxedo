import { describe, expect, it } from "bun:test"
import path from "node:path"
import type { WithInternals } from "../../test-utils/class-internals"
import { AcpHarnessAdapter } from "./index"

type BaseInternals = {
  options: { binary: string; storeRoot?: string }
  currentModel: string
  dirs: Set<string>
  sessions: Map<string, unknown>
  busySessions: Set<string>
  shared: {
    proc: { alive: boolean } | null
    init: null
    refs: number
    key: string
    model: string
    leases: Set<AcpHarnessAdapter>
  }
}

/** `Extra` names the extra internals a given test drives; see workspace-behavior.test.ts. */
function adapter<Extra extends object = Record<never, never>>() {
  const out = Object.create(AcpHarnessAdapter.prototype) as WithInternals<
    AcpHarnessAdapter,
    Omit<BaseInternals, keyof Extra> & Extra
  >
  const defaults: BaseInternals = {
    options: { binary: "fake-acp" },
    currentModel: "",
    dirs: new Set(),
    sessions: new Map(),
    busySessions: new Set(),
    shared: {
      proc: null,
      init: null,
      refs: 1,
      key: "test",
      model: "",
      leases: new Set(),
    },
  }
  Object.assign(out, defaults)
  return out
}

describe("AcpHarnessAdapter.createSession", () => {
  it("fails promptly when ACP newSession hangs", async () => {
    const directory = path.resolve("/work")
    const prev = process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS
    process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS = "10"
    let dead = false

    const out = adapter<{
      getOrSpawnProcess: (id: string, directory: string) => Promise<{
        proc: {
          newSession: (directory: string, title?: string) => Promise<string>
          dispose: () => void
        }
        isNew: boolean
      }>
      store: {
        getSession: (id: string) => unknown
        bindSession: (input: unknown) => void
        updateSessionConfig: (id: string, cfg: unknown) => void
      }
    }>()
    out.store = {
      getSession: () => undefined,
      bindSession() {
        throw new Error("bindSession should not be called")
      },
      updateSessionConfig() {},
    }
    out.getOrSpawnProcess = async (_id, directory) => {
      expect(directory).toBe(path.resolve("/work"))
      return {
        isNew: true,
        proc: {
          newSession: async (dir, title) => {
            expect(dir).toBe(directory)
            expect(title).toBe("Test")
            return new Promise(() => {})
          },
          dispose: () => {
            dead = true
          },
        },
      }
    }

    try {
      await expect(out.createSession("/work", "Test")).rejects.toThrow("ACP newSession timed out after 10ms")
      expect(dead).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS
      else process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS = prev
    }
  })

  it("spawns a separate process per session", async () => {
    let spawns = 0
    let sessions = 0
    const make = () => {
      spawns++
      return {
        alive: true,
        cachedConfigOptions: null,
        initialize: async () => {},
        newSession: async (_directory: string) => `acp-${++sessions}`,
        dispose: () => {},
      }
    }

    const store = {
      getSession: () => undefined,
      bindSession() {},
      updateSessionConfig() {},
    }
    const a = adapter<{
      make: () => {
        alive: boolean
        cachedConfigOptions: unknown[] | null
        initialize: () => Promise<void>
        newSession: (directory: string, title?: string) => Promise<string>
        dispose: () => void
      }
      store: {
        getSession: (id: string) => unknown
        bindSession: (input: unknown) => void
        updateSessionConfig: (id: string, cfg: unknown) => void
      }
    }>()
    const b = adapter<{
      make: () => {
        alive: boolean
        cachedConfigOptions: unknown[] | null
        initialize: () => Promise<void>
        newSession: (directory: string, title?: string) => Promise<string>
        dispose: () => void
      }
      store: {
        getSession: (id: string) => unknown
        bindSession: (input: unknown) => void
        updateSessionConfig: (id: string, cfg: unknown) => void
      }
    }>()
    a.options = { binary: "fake-acp" }
    b.options = { binary: "fake-acp" }
    a.store = store
    b.store = store
    a.make = make
    b.make = make

    await a.createSession("/work/a")
    await b.createSession("/work/b")
    expect(spawns).toBe(2)
    expect(sessions).toBe(2)
  })

  it("binds a requested deterministic Session id", async () => {
    const bindings: unknown[] = []
    const out = adapter<{
      getOrSpawnProcess: (id: string, directory: string) => Promise<{
        proc: {
          newSession: (directory: string, title?: string) => Promise<string>
        }
        isNew: boolean
      }>
      store: {
        getSession: (id: string) => unknown
        bindSession: (input: unknown) => void
        updateSessionConfig: (id: string, cfg: unknown) => void
      }
    }>()
    out.store = {
      getSession: () => undefined,
      bindSession: (input) => bindings.push(input),
      updateSessionConfig() {},
    }
    out.getOrSpawnProcess = async () => ({
      isNew: true,
      proc: { newSession: async () => "agent-session-1" },
    })

    await expect(out.createSession("/work", "Stable", "ses_wgrun_run_1"))
      .resolves.toEqual({ id: "ses_wgrun_run_1" })
    expect(bindings).toEqual([
      expect.objectContaining({ sessionId: "ses_wgrun_run_1", agentSessionId: "agent-session-1" }),
    ])
  })
})

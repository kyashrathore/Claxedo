import { describe, expect, it } from "bun:test"
import { ACPAdapter } from "./acp"

function adapter() {
  const out = Object.create(ACPAdapter.prototype) as ACPAdapter & {
    options: { binary: string; type?: string; storeRoot?: string }
    currentModel: string
    dirs: Set<string>
    shared: {
      proc: { alive: boolean } | null
      init: null
      refs: number
      key: string
      model: string
      leases: Set<ACPAdapter>
    }
  }
  out.options = { binary: "fake-acp" }
  out.currentModel = ""
  out.dirs = new Set()
  ;(out as any).sessions = new Map()
  ;(out as any).busySessions = new Set()
  out.shared = {
    proc: null,
    init: null,
    refs: 1,
    key: "test",
    model: "",
    leases: new Set(),
  }
  return out
}

describe("ACPAdapter.createSession", () => {
  it("fails promptly when ACP newSession hangs", async () => {
    const prev = process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS
    process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS = "10"
    let dead = false

    const out = adapter() as ACPAdapter & {
      getOrSpawnProcess: (id: string, directory: string) => Promise<{
        proc: {
          newSession: (directory: string, title?: string) => Promise<string>
          dispose: () => void
        }
        isNew: boolean
      }>
      store: { bindSession: (input: unknown) => void; updateSessionConfig: (id: string, cfg: unknown) => void }
    }
    out.store = {
      bindSession() {
        throw new Error("bindSession should not be called")
      },
      updateSessionConfig() {},
    }
    out.getOrSpawnProcess = async (_id, directory) => {
      expect(directory).toBe("/work")
      return {
        isNew: true,
        proc: {
          newSession: async (dir, title) => {
            expect(dir).toBe("/work")
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
      bindSession() {},
      updateSessionConfig() {},
    }
    const a = adapter() as ACPAdapter & {
      make: () => {
        alive: boolean
        cachedConfigOptions: unknown[] | null
        initialize: () => Promise<void>
        newSession: (directory: string, title?: string) => Promise<string>
        dispose: () => void
      }
      store: { bindSession: (input: unknown) => void; updateSessionConfig: (id: string, cfg: unknown) => void }
    }
    const b = adapter() as ACPAdapter & {
      make: () => {
        alive: boolean
        cachedConfigOptions: unknown[] | null
        initialize: () => Promise<void>
        newSession: (directory: string, title?: string) => Promise<string>
        dispose: () => void
      }
      store: { bindSession: (input: unknown) => void; updateSessionConfig: (id: string, cfg: unknown) => void }
    }
    a.options = { binary: "fake-acp", type: "claude-acp" }
    b.options = { binary: "fake-acp", type: "claude-acp" }
    a.store = store
    b.store = store
    a.make = make
    b.make = make

    await a.createSession("/work/a")
    await b.createSession("/work/b")
    expect(spawns).toBe(2)
    expect(sessions).toBe(2)
  })
})

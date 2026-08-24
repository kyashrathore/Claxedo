import { beforeEach, describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStore } from "solid-js"

describe("persisted storage", () => {
  beforeEach(() => {
    localStorage.clear()
    window.location.href = "http://localhost/"
  })

  test("corrupted JSON is treated as missing for structured stores (and removed)", async () => {
    localStorage.setItem("k", "{") // invalid JSON
    const { persisted } = await import(`./persist?test=${Date.now()}`)

    createRoot(() => {
      const store = createStore({ a: 1 })
      const out = persisted("k", store)
      expect(out[0].a).toBe(1)
      // Trigger ready accessor so the persisted init path is exercised.
      out[3]()
    })

    // makePersisted may read from storage on a scheduled task; allow it to run.
    await new Promise<void>((r) => setTimeout(r, 0))

    const raw = localStorage.getItem("k")
    // We either remove it or rewrite defaults, but it must not stay corrupted.
    if (raw === null) return
    expect(raw).not.toBe("{")
    const parsed = JSON.parse(raw) as { a: number }
    expect(parsed.a).toBe(1)
  })

  test("migrate runs before merge and persisted output keeps default keys", async () => {
    localStorage.setItem("k", JSON.stringify({ legacyCount: 7 }))
    const { persisted } = await import(`./persist?test=${Date.now()}`)

    createRoot(() => {
      const store = createStore({ count: 0, enabled: true })
      const out = persisted(
        {
          key: "k",
          migrate: (value: unknown) => ({
            count: (value as { legacyCount?: number }).legacyCount ?? 0,
          }),
        },
        store,
      )
      expect(out[0].count).toBe(7)
      expect(out[0].enabled).toBe(true)
      out[3]()
    })

    await new Promise<void>((r) => setTimeout(r, 0))

    const raw = localStorage.getItem("k")
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw!) as { count: number; enabled: boolean }
    expect(parsed).toEqual({ count: 7, enabled: true })
  })

  test("legacy key is migrated into current key and removed", async () => {
    localStorage.setItem("legacy.k", JSON.stringify({ a: 9 }))
    const { persisted } = await import(`./persist?test=${Date.now()}`)

    createRoot(() => {
      const store = createStore({ a: 1, b: 2 })
      const out = persisted({ key: "k", legacy: ["legacy.k"] }, store)
      expect(out[0].a).toBe(9)
      expect(out[0].b).toBe(2)
      out[3]()
    })

    await new Promise<void>((r) => setTimeout(r, 0))

    expect(localStorage.getItem("legacy.k")).toBeNull()
    const raw = localStorage.getItem("k")
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw!) as { a: number; b: number }
    expect(parsed).toEqual({ a: 9, b: 2 })
  })

  test("demo mode keeps persisted app state out of localStorage", async () => {
    window.location.href = "http://localhost/demo/"

    const real = JSON.stringify({
      list: ["https://real.example"],
      projects: { live: [{ worktree: "/real", expanded: true }] },
      lastProject: { live: "/real" },
      workspaceServer: {},
    })
    localStorage.setItem("opencode.global.dat:server", real)

    const { Persist, persisted, resetDemoPersisted, setPersisted } = await import(`./persist?test=${Date.now()}`)
    resetDemoPersisted()
    setPersisted(Persist.global("server"), {
      list: [],
      projects: {
        demo: [{ worktree: "/demo", expanded: true }],
      },
      lastProject: { demo: "/demo" },
      workspaceServer: {},
    })

    createRoot(() => {
      const store = createStore({
        list: [] as string[],
        projects: {} as Record<string, Array<{ worktree: string; expanded: boolean }>>,
        lastProject: {} as Record<string, string>,
        workspaceServer: {} as Record<string, string>,
      })
      const out = persisted(Persist.global("server"), store)
      expect(out[0].projects).toEqual({
        demo: [{ worktree: "/demo", expanded: true }],
      })
      out[1]("projects", "demo", [{ worktree: "/demo-2", expanded: false }])
      out[3]()
    })

    await new Promise<void>((r) => setTimeout(r, 0))

    expect(localStorage.getItem("opencode.global.dat:server")).toBe(real)
    expect(localStorage.getItem("opencode.demo.global.dat:server")).toBeNull()
  })

  test("server-scoped persistence treats localhost and 127.0.0.1 as the same server", async () => {
    const { Persist } = await import(`./persist?test=${Date.now()}`)

    const a = Persist.serverWorkspace("http://localhost:3001", "/workspace", "terminal.v2")
    const b = Persist.serverWorkspace("http://127.0.0.1:3001", "/workspace", "terminal.v2")
    const c = Persist.serverGlobal("http://localhost:3001", "server")
    const d = Persist.serverGlobal("http://127.0.0.1:3001", "server")

    expect(a).toEqual(b)
    expect(c).toEqual(d)
  })
})

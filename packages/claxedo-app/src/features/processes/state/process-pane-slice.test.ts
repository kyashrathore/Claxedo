import { describe, expect, test } from "bun:test"
import { createMemo, createRoot } from "solid-js"
import { createProcessPaneSlice, type ProcessPaneSliceApi } from "./process-pane-slice"

/**
 * The host state this slice reads through, plus a record of every write it
 * makes. The real host is the workbench store; the slice only ever touches
 * `processPane`, so a plain object is a faithful stand-in and lets a test
 * assert on the exact (scope, field, value) triple that reaches the store.
 */
function host() {
  const state = {
    processPane: {
      crashedWhileClosed: false,
      pendingAction: null as "startAll" | "stopAll" | "add" | null,
    },
  }
  const writes: Array<[string, string, unknown]> = []
  const setState = ((scope: "processPane", field: "crashedWhileClosed" | "pendingAction", value: never) => {
    writes.push([scope, field, value])
    state.processPane[field] = value
  }) as Parameters<typeof createProcessPaneSlice>[0]["setState"]
  return { state, setState, writes }
}

function slice() {
  const deps = host()
  return { ...deps, api: createProcessPaneSlice({ state: deps.state, setState: deps.setState }) }
}

describe("createProcessPaneSlice transient status", () => {
  test("a directory is running only after it is set, and stops being so when cleared", () => {
    const { api } = slice()

    expect(api.running("/repo/a")).toBe(false)

    api.setRunning("/repo/a", true)
    expect(api.running("/repo/a")).toBe(true)
    // Absence is the only "not running" state — clearing must actually remove
    // the directory, not leave it stored as `false`.
    api.setRunning("/repo/a", false)
    expect(api.running("/repo/a")).toBe(false)
  })

  test("running and crashed are independent per directory", () => {
    const { api } = slice()

    api.setRunning("/repo/a", true)
    api.setCrashed("/repo/b", true)

    expect(api.running("/repo/a")).toBe(true)
    expect(api.crashed("/repo/a")).toBe(false)
    expect(api.running("/repo/b")).toBe(false)
    expect(api.crashed("/repo/b")).toBe(true)
  })

  test("clearing one directory leaves the others alone", () => {
    const { api } = slice()

    api.setRunning("/repo/a", true)
    api.setRunning("/repo/b", true)
    api.setRunning("/repo/a", false)

    expect(api.running("/repo/a")).toBe(false)
    expect(api.running("/repo/b")).toBe(true)
  })

  test.each([
    ["the `__process__` sentinel", "__process__"],
    ["null", null],
    ["undefined", undefined],
    ["an empty string", ""],
  ])("%s is not a directory: writes are dropped and reads are false", (_label, directory) => {
    const { api } = slice()

    api.setRunning(directory, true)
    api.setCrashed(directory, true)

    expect(api.running(directory)).toBe(false)
    expect(api.crashed(directory)).toBe(false)
    // Nor does the non-directory leak into a real one.
    expect(api.running("/repo/a")).toBe(false)
  })

  test("a no-op write does not notify subscribers", () => {
    // This is the whole reason the setter compares before it allocates. The
    // status poller calls `setRunning(dir, running)` on every tick with an
    // unchanged value; if each call published a fresh Set, every process pane
    // in the workbench would recompute on a timer forever.
    createRoot((dispose) => {
      const api: ProcessPaneSliceApi = createProcessPaneSlice(host())
      let recomputes = 0
      const isRunning = createMemo(() => {
        recomputes += 1
        return api.running("/repo/a")
      })

      expect(isRunning()).toBe(false)
      expect(recomputes).toBe(1)

      api.setRunning("/repo/a", true)
      expect(isRunning()).toBe(true)
      expect(recomputes).toBe(2)

      api.setRunning("/repo/a", true)
      expect(isRunning()).toBe(true)
      expect(recomputes).toBe(2)

      // A real change still gets through after the no-op.
      api.setRunning("/repo/a", false)
      expect(isRunning()).toBe(false)
      expect(recomputes).toBe(3)

      dispose()
    })
  })

  test("clearing a directory that was never set is also a no-op", () => {
    createRoot((dispose) => {
      const api: ProcessPaneSliceApi = createProcessPaneSlice(host())
      let recomputes = 0
      const isRunning = createMemo(() => {
        recomputes += 1
        return api.running("/repo/a")
      })

      expect(isRunning()).toBe(false)
      api.setRunning("/repo/a", false)
      expect(isRunning()).toBe(false)
      expect(recomputes).toBe(1)

      dispose()
    })
  })
})

describe("createProcessPaneSlice host-backed state", () => {
  test("crashedWhileClosed reads and writes through the host store", () => {
    const { api, state, writes } = slice()

    expect(api.crashedWhileClosed()).toBe(false)

    api.setCrashedWhileClosed(true)
    expect(writes).toEqual([["processPane", "crashedWhileClosed", true]])
    expect(state.processPane.crashedWhileClosed).toBe(true)
    expect(api.crashedWhileClosed()).toBe(true)
  })

  test.each([
    ["requestStartAll", "startAll"],
    ["requestStopAll", "stopAll"],
    ["requestAddProcess", "add"],
  ] as const)("%s records its pending action on the host store", (method, expected) => {
    const { api, writes } = slice()

    api[method]()

    expect(writes).toEqual([["processPane", "pendingAction", expected]])
    expect(api.pendingAction()).toBe(expected)
  })

  test("clearPendingAction returns the store to null", () => {
    const { api } = slice()

    api.requestStartAll()
    api.clearPendingAction()

    expect(api.pendingAction()).toBe(null)
  })
})

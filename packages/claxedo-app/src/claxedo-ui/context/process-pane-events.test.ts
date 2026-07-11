import { beforeEach, describe, expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import type { Process } from "@claxedo/process/process"
import { createProcessEventHandlers, type ProcessEventDeps, type ProcessPaneStore } from "./process-pane-events"

type ManagedProcess = Process.ManagedProcess

let store: ProcessPaneStore
let calls: {
  owned: Array<[string, string]>
  removedAutoTabs: string[]
  syncs: number
  crashedWhileClosed: boolean[]
  fetches: number
  openedTabs: Array<[string, string]>
}
let open: boolean
let pendingTabOpens: Set<string>

function makeHandlers() {
  const [s, setStore] = createStore<ProcessPaneStore>({ configs: [], processes: {}, paneHeight: 300 })
  store = s
  const deps: ProcessEventDeps = {
    store: s,
    setStore,
    ownProcess: (configId, ptyId) => calls.owned.push([configId, ptyId]),
    removeAutoCreatedTab: (ptyId) => calls.removedAutoTabs.push(ptyId),
    sync: () => calls.syncs++,
    isProcessOpen: () => open,
    setCrashedWhileClosed: (v) => calls.crashedWhileClosed.push(v),
    fetchProcesses: () => calls.fetches++,
    pendingTabOpens,
    openTerminalTab: (configId, ptyId) => calls.openedTabs.push([configId, ptyId]),
  }
  return createProcessEventHandlers(deps)
}

beforeEach(() => {
  calls = { owned: [], removedAutoTabs: [], syncs: 0, crashedWhileClosed: [], fetches: 0, openedTabs: [] }
  open = false
  pendingTabOpens = new Set()
})

describe("process.started handler", () => {
  test("marks the process running, owns its pty, drops the auto tab, and syncs", () => {
    const h = makeHandlers()
    h.started({ configId: "web", ptyId: "pty_1" })
    expect(store.processes.web).toMatchObject({ configId: "web", status: "running", ptyId: "pty_1" })
    expect(calls.owned).toEqual([["web", "pty_1"]])
    expect(calls.removedAutoTabs).toEqual(["pty_1"])
    expect(calls.syncs).toBe(1)
  })

  test("opens a pending tab once the pty is known and clears the pending flag", () => {
    pendingTabOpens.add("web")
    const h = makeHandlers()
    h.started({ configId: "web", ptyId: "pty_1" })
    expect(calls.openedTabs).toEqual([["web", "pty_1"]])
    expect(pendingTabOpens.has("web")).toBe(false)
  })
})

describe("process.stopped handler", () => {
  test("records exit and clears the pty for an existing process", () => {
    const h = makeHandlers()
    h.started({ configId: "web", ptyId: "pty_1" })
    h.stopped({ configId: "web", exitCode: 0 })
    expect(store.processes.web).toMatchObject({ status: "stopped", exitCode: 0 })
    expect(store.processes.web?.ptyId).toBeUndefined()
  })
})

describe("process.crashed handler", () => {
  test("while the pane is CLOSED it raises the persisted attention badge and re-fetches", () => {
    open = false
    const h = makeHandlers()
    h.crashed({ configId: "web", exitCode: 1, restartCount: 2, ptyId: "pty_1" })
    expect(store.processes.web).toMatchObject({ status: "crashed", ptyId: "pty_1", exitCode: 1, restartCount: 2 })
    expect(calls.owned).toEqual([["web", "pty_1"]]) // recovered from the event ptyId
    expect(calls.crashedWhileClosed).toEqual([true])
    expect(calls.fetches).toBe(1)
  })

  test("while the pane is OPEN it does not raise the closed badge", () => {
    open = true
    const h = makeHandlers()
    h.crashed({ configId: "web", exitCode: 1, restartCount: 0, ptyId: "pty_1" })
    expect(calls.crashedWhileClosed).toEqual([])
  })
})

describe("process.status handler", () => {
  test("ignores an unknown status string", () => {
    const h = makeHandlers()
    h.status({ configId: "web", status: "bogus" })
    expect(store.processes.web).toBeUndefined()
    expect(calls.syncs).toBe(0)
  })

  test("rejects a stale 'stopping' event for an already-crashed process", () => {
    const h = makeHandlers()
    h.crashed({ configId: "web", exitCode: 1, restartCount: 0, ptyId: "pty_1" })
    const before = store.processes.web?.status
    h.status({ configId: "web", status: "stopping" })
    expect(store.processes.web?.status).toBe(before!)
  })

  test("a crashed status re-fetches to pick up conflict fields", () => {
    const h = makeHandlers()
    h.status({ configId: "web", status: "crashed" })
    expect(store.processes.web).toMatchObject({ status: "crashed" })
    expect(calls.fetches).toBe(1)
  })
})

describe("process.config.changed handler", () => {
  test("adds idle entries for new configs and drops entries whose config was removed", () => {
    const h = makeHandlers()
    h.started({ configId: "web", ptyId: "pty_1" }) // pre-existing running process kept
    h.configChanged({
      configs: [
        { id: "web", name: "web", command: "node web.js", directory: "/repo" },
        { id: "api", name: "api", command: "node api.js", directory: "/repo" },
      ],
    })
    expect(store.processes.web).toMatchObject({ status: "running" }) // preserved
    expect(store.processes.api).toMatchObject({ configId: "api", status: "idle" }) // created idle
    // A config that vanishes drops its process entry.
    h.configChanged({ configs: [{ id: "api", name: "api", command: "node api.js", directory: "/repo" }] })
    expect(store.processes.web).toBeUndefined()
    expect(store.processes.api).toMatchObject({ status: "idle" })
  })
})

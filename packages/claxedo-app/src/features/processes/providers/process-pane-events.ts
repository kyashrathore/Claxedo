// The five process SSE handlers (process.started/stopped/crashed/status/
// config.changed), split out of process-pane.tsx so each is a plain function
// unit-testable against fakes without mounting the Solid context.
//
// Handlers mutate the persisted process store and call back into the provider
// for cross-cutting concerns (ownership, tab ops, status sync, reconcile
// fetch) via the injected deps — the exact closures the provider used inline.

import { batch } from "solid-js"
import { reconcile, type SetStoreFunction } from "solid-js/store"
import { Process } from "@/features/processes/data"
import { decodeProcessConfigs, decodeProcessStatus } from "./process-pane-decode"

type ManagedProcess = Process.ManagedProcess
type ProcessStatus = Process.Status
type ProcessConfig = Process.ProcessConfig

export type ProcessPaneStore = {
  configs: ProcessConfig[]
  processes: Record<string, ManagedProcess>
  paneHeight: number
}

export type ProcessEventDeps = {
  store: ProcessPaneStore
  setStore: SetStoreFunction<ProcessPaneStore>
  ownProcess: (configId: string, ptyId: string) => void
  removeAutoCreatedTab: (ptyId: string) => void
  sync: () => void
  isProcessOpen: () => boolean
  setCrashedWhileClosed: (value: boolean) => void
  fetchProcesses: () => void
  pendingTabOpens: Set<string>
  openTerminalTab: (configId: string, ptyId: string) => void
}

export function createProcessEventHandlers(deps: ProcessEventDeps) {
  const {
    store,
    setStore,
    ownProcess,
    removeAutoCreatedTab,
    sync,
    isProcessOpen,
    setCrashedWhileClosed,
    fetchProcesses,
    pendingTabOpens,
    openTerminalTab,
  } = deps

  const started = (event: { configId: string; ptyId: string }) => {
    const { configId, ptyId } = event
    // Own the PTY before updating the store — the detection
    // effect's existing `owner` check will skip it.
    if (ptyId) {
      ownProcess(configId, ptyId)
      removeAutoCreatedTab(ptyId)
    }
    setStore("processes", configId, {
      configId,
      ptyId,
      status: "running" as ProcessStatus,
      restartCount: store.processes[configId]?.restartCount ?? 0,
      startedAt: Date.now(),
      exitedAt: undefined,
      exitCode: undefined,
    })
    // If openInTab was called before the process was running,
    // open the terminal tab now that we have a ptyId.
    if (pendingTabOpens.has(configId) && ptyId) {
      pendingTabOpens.delete(configId)
      openTerminalTab(configId, ptyId)
    }
    sync()
  }

  const stopped = (event: { configId: string; exitCode: number }) => {
    const { configId, exitCode } = event
    const existing = store.processes[configId]
    if (existing) {
      setStore("processes", configId, {
        ...existing,
        status: "stopped" as ProcessStatus,
        ptyId: undefined,
        exitCode,
        exitedAt: Date.now(),
      })
    }
    sync()
  }

  const crashed = (event: { configId: string; exitCode: number; restartCount: number; ptyId?: string }) => {
    // Fires when the PTY itself dies OR when the inner command exits
    // inside the interactive shell (detected via OSC process-exit marker).
    // Preserve existing ptyId via spread, and also accept ptyId from the
    // event itself (command-exit crashes include it) so even if the client
    // store was cleared (e.g. during mount), the ptyId is recovered.
    const { configId, exitCode, restartCount, ptyId: eventPtyId } = event
    const existing = store.processes[configId]
    const ptyId = existing?.ptyId ?? eventPtyId
    if (ptyId) {
      ownProcess(configId, ptyId)
    }
    setStore("processes", configId, {
      ...(existing ?? { configId }),
      status: "crashed" as ProcessStatus,
      ptyId,
      exitCode,
      restartCount,
      exitedAt: Date.now(),
    })
    // Alert workspace dot indicator when the process panel is not active.
    if (!isProcessOpen()) {
      setCrashedWhileClosed(true)
    }
    sync()
    fetchProcesses()
  }

  const status = (event: { configId: string; status: string }) => {
    const { configId } = event
    const decoded = decodeProcessStatus(event.status)
    if (!decoded) return
    const existing = store.processes[configId]
    // Guard: reject stale "stopping" events for processes already
    // in a terminal state. Once confirmed stopped/crashed (via
    // belt-and-suspenders or process.stopped/crashed SSE), only
    // "starting" (explicit user action) should transition out.
    if (
      existing &&
      decoded === "stopping" &&
      (existing.status === "stopped" || existing.status === "crashed")
    ) {
      return
    }
    if (existing) {
      setStore("processes", configId, {
        ...existing,
        status: decoded,
      })
    } else {
      setStore("processes", configId, {
        configId,
        status: decoded,
        restartCount: 0,
      })
    }
    sync()
    // Port-conflict crashes only emit process.status (not process.crashed).
    // Re-fetch to pick up the full state including the conflict field so
    // the inline overlay can render.
    if (decoded === "crashed") {
      fetchProcesses()
    }
  }

  const configChanged = (event: { configs: unknown[] }) => {
    const configs = decodeProcessConfigs(event.configs)
    const configIds = new Set(configs.map((c) => c.id))
    batch(() => {
      setStore("configs", reconcile(configs, { key: "id" }))
      // Reconcile process entries: keep existing for known configs,
      // create idle entries for new configs, drop removed ones.
      const next: Record<string, ManagedProcess> = {}
      for (const id of configIds) {
        if (store.processes[id]) {
          next[id] = store.processes[id]!
        } else {
          next[id] = {
            configId: id,
            status: "idle",
            restartCount: 0,
          }
        }
      }
      setStore("processes", reconcile(next))
    })
    sync()
  }

  return { started, stopped, crashed, status, configChanged }
}

// Process-pane slice — crash flag, pending tab-bar action, and transient
// running/crashed status by directory.

import { createSignal } from "solid-js"
import type { SetStoreFunction } from "solid-js/store"
import type { ClaxedoState } from "./types"

const real = (dir?: string | null) => {
  if (!dir || dir === "__process__") return undefined
  return dir
}

export type ProcessPaneSliceApi = {
  // ── persisted ───────────────────────────────────────────────────────────
  crashedWhileClosed(): boolean
  setCrashedWhileClosed(value: boolean): void

  pendingAction(): "startAll" | "stopAll" | "add" | null
  requestStartAll(): void
  requestStopAll(): void
  requestAddProcess(): void
  clearPendingAction(): void

  // ── transient (running/crashed by directory, populated by ProcessPaneProvider) ─
  running(directory?: string | null): boolean
  crashed(directory?: string | null): boolean
  setRunning(directory: string | null | undefined, value: boolean): void
  setCrashed(directory: string | null | undefined, value: boolean): void
}

export function createProcessPaneSlice(input: {
  state: ClaxedoState
  setState: SetStoreFunction<ClaxedoState>
}): ProcessPaneSliceApi {
  const { state, setState } = input

  const [running, setRunning] = createSignal<Record<string, boolean>>({})
  const [crashed, setCrashed] = createSignal<Record<string, boolean>>({})

  const updateMap = (
    setter: typeof setRunning,
    directory: string | null | undefined,
    value: boolean,
  ) => {
    const dir = real(directory)
    if (!dir) return
    setter((all) => {
      if (value) {
        if (all[dir]) return all
        return { ...all, [dir]: true }
      }
      if (!all[dir]) return all
      const next = { ...all }
      delete next[dir]
      return next
    })
  }

  return {
    crashedWhileClosed() {
      return state.processPane.crashedWhileClosed
    },
    setCrashedWhileClosed(value) {
      setState("processPane", "crashedWhileClosed", value)
    },
    pendingAction() {
      return state.processPane.pendingAction
    },
    requestStartAll() {
      setState("processPane", "pendingAction", "startAll")
    },
    requestStopAll() {
      setState("processPane", "pendingAction", "stopAll")
    },
    requestAddProcess() {
      setState("processPane", "pendingAction", "add")
    },
    clearPendingAction() {
      setState("processPane", "pendingAction", null)
    },
    running(directory) {
      const dir = real(directory)
      if (!dir) return false
      return !!running()[dir]
    },
    crashed(directory) {
      const dir = real(directory)
      if (!dir) return false
      return !!crashed()[dir]
    },
    setRunning(directory, value) {
      updateMap(setRunning, directory, value)
    },
    setCrashed(directory, value) {
      updateMap(setCrashed, directory, value)
    },
  }
}

// Process-pane slice — crash flag, pending tab-bar action, and transient
// running/crashed status by directory.

import { createSignal, type StoreSetter } from "solid-js"

type PendingProcessAction = "startAll" | "stopAll" | "add" | null

type ProcessPaneHostState = {
  processPane: {
    crashedWhileClosed: boolean
    pendingAction: PendingProcessAction
  }
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

export function createProcessPaneSlice<T extends ProcessPaneHostState>(input: {
  state: T
  setState: StoreSetter<T>
}): ProcessPaneSliceApi {
  const { state, setState } = input

  const [running, setRunning] = createSignal<Record<string, boolean>>({})
  const [crashed, setCrashed] = createSignal<Record<string, boolean>>({})

  const updateMap = (setter: typeof setRunning, directory: string | null | undefined, value: boolean) => {
    const dir = realDirectory(directory)
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
      setState((state) => {
        state.processPane.crashedWhileClosed = value
      })
    },
    pendingAction() {
      return state.processPane.pendingAction
    },
    requestStartAll() {
      setState((state) => {
        state.processPane.pendingAction = "startAll"
      })
    },
    requestStopAll() {
      setState((state) => {
        state.processPane.pendingAction = "stopAll"
      })
    },
    requestAddProcess() {
      setState((state) => {
        state.processPane.pendingAction = "add"
      })
    },
    clearPendingAction() {
      setState((state) => {
        state.processPane.pendingAction = null
      })
    },
    running(directory) {
      const dir = realDirectory(directory)
      if (!dir) return false
      return !!running()[dir]
    },
    crashed(directory) {
      const dir = realDirectory(directory)
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

function realDirectory(directory?: string | null) {
  if (!directory || directory === "__process__") return
  return directory
}

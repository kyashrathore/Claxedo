// Process-pane slice — crash flag, pending tab-bar action, and transient
// running/crashed status by directory.

import { createSignal } from "solid-js"

type PendingProcessAction = "startAll" | "stopAll" | "add" | null

type ProcessPaneHostState = {
  processPane: {
    crashedWhileClosed: boolean
    pendingAction: PendingProcessAction
  }
}

type ProcessPaneHostSetter = {
  (scope: "processPane", field: "crashedWhileClosed", value: boolean): void
  (scope: "processPane", field: "pendingAction", value: PendingProcessAction): void
}

/**
 * Every member is declared as a function-valued PROPERTY, not a method: these
 * are closures over the host state and this slice's signals, they never read
 * `this`, and callers routinely hand single members straight to a child (see
 * `createProcessPaneSync({ setRunning: processPane.setRunning })`). Method
 * syntax would promise a receiver that does not exist and make every one of
 * those hand-offs an unbound-method hazard.
 */
export type ProcessPaneSliceApi = {
  // ── persisted ───────────────────────────────────────────────────────────
  crashedWhileClosed: () => boolean
  setCrashedWhileClosed: (value: boolean) => void

  pendingAction: () => PendingProcessAction
  requestStartAll: () => void
  requestStopAll: () => void
  requestAddProcess: () => void
  clearPendingAction: () => void

  // ── transient (running/crashed by directory, populated by ProcessPaneProvider) ─
  running: (directory?: string | null) => boolean
  crashed: (directory?: string | null) => boolean
  setRunning: (directory: string | null | undefined, value: boolean) => void
  setCrashed: (directory: string | null | undefined, value: boolean) => void
}

export function createProcessPaneSlice(input: {
  state: ProcessPaneHostState
  setState: ProcessPaneHostSetter
}): ProcessPaneSliceApi {
  const { state, setState } = input

  // A directory is either in the set or absent; there is no third state, which
  // is why this is a Set rather than a `Record<string, boolean>` whose deleted
  // keys read back as `undefined` behind a `boolean` type.
  const [running, setRunning] = createSignal<ReadonlySet<string>>(new Set())
  const [crashed, setCrashed] = createSignal<ReadonlySet<string>>(new Set())

  const updateSet = (
    setter: typeof setRunning,
    directory: string | null | undefined,
    value: boolean,
  ) => {
    const dir = realDirectory(directory)
    if (!dir) return
    setter((all) => {
      if (all.has(dir) === value) return all
      const next = new Set(all)
      if (value) next.add(dir)
      else next.delete(dir)
      return next
    })
  }

  return {
    crashedWhileClosed: () => state.processPane.crashedWhileClosed,
    setCrashedWhileClosed: (value) => setState("processPane", "crashedWhileClosed", value),
    pendingAction: () => state.processPane.pendingAction,
    requestStartAll: () => setState("processPane", "pendingAction", "startAll"),
    requestStopAll: () => setState("processPane", "pendingAction", "stopAll"),
    requestAddProcess: () => setState("processPane", "pendingAction", "add"),
    clearPendingAction: () => setState("processPane", "pendingAction", null),
    running: (directory) => {
      const dir = realDirectory(directory)
      return dir ? running().has(dir) : false
    },
    crashed: (directory) => {
      const dir = realDirectory(directory)
      return dir ? crashed().has(dir) : false
    },
    setRunning: (directory, value) => updateSet(setRunning, directory, value),
    setCrashed: (directory, value) => updateSet(setCrashed, directory, value),
  }
}

function realDirectory(directory?: string | null): string | undefined {
  if (!directory || directory === "__process__") return undefined
  return directory
}

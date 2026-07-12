// Pure status derivation + the sync side-effect for the process pane,
// extracted from process-pane.tsx so both are unit-testable without mounting
// the Solid context.
//
// Two bugs against the "a crashed process always lights the toolbar attention
// dot" invariant (core-processes:1166) are fixed here:
//   1. A crash discovered via the GET /api/wr/process reconcile (fetchProcesses
//      → sync) never raised the persisted `crashedWhileClosed` attention badge,
//      even though the live `process.crashed` SSE handler does. So a crash the
//      client only learns about on the next reconcile lit nothing while the
//      pane was closed. `createProcessPaneSync` now mirrors the SSE handler.
//   2. The provider's onCleanup unconditionally reset `crashed` to false (see
//      process-pane.tsx) — handled at that call site by no longer clearing it.

import type { Process } from "@/features/processes/data"

type ManagedProcess = Process.ManagedProcess

/**
 * True when `incoming` is a stale HTTP-response snapshot that must NOT
 * overwrite the client's current state for this process.
 *
 * Root cause (status heading stuck green after a process crashes):
 * `client.start()`'s HTTP response captures process state at the moment the
 * PTY spawned (status "running"), taken server-side BEFORE the launched
 * command has necessarily finished executing. If that command exits (e.g.
 * `exit 1`) fast enough, the SSE `process.crashed` event can reach the
 * browser and update the store to "crashed" BEFORE the slower HTTP response
 * for the original `start()` call resolves. When that HTTP response then
 * arrives, `applyProcess` would blindly overwrite the store back to
 * "running" with the stale snapshot — the exact race that leaves the status
 * dot green for an already-dead process. `process.status` SSE events already
 * guard the mirror-image race for "stopping"; this guards the HTTP-response
 * side for "crashed"/"stopped".
 *
 * Scoped to the SAME ptyId (spawn generation): a subsequent start/restart
 * legitimately gets a new ptyId and must always apply normally.
 */
export function isStaleProcessSnapshot(
  existing: ManagedProcess | undefined,
  incoming: ManagedProcess,
): boolean {
  if (!existing) return false
  if (existing.status !== "crashed" && existing.status !== "stopped") return false
  if (!existing.ptyId || !incoming.ptyId) return false
  return existing.ptyId === incoming.ptyId
}

export function deriveProcessPaneStatus(
  processes: Record<string, ManagedProcess | undefined>,
): { running: boolean; crashed: boolean } {
  let running = false
  let crashed = false
  for (const id in processes) {
    const status = processes[id]?.status
    if (status === "running" || status === "starting" || status === "restarting") running = true
    if (status === "crashed") crashed = true
  }
  return { running, crashed }
}

export type ProcessPaneSyncDeps = {
  processes: () => Record<string, ManagedProcess | undefined>
  directory: () => string | null | undefined
  isProcessOpen: () => boolean
  setRunning: (directory: string | null | undefined, value: boolean) => void
  setCrashed: (directory: string | null | undefined, value: boolean) => void
  setCrashedWhileClosed: (value: boolean) => void
}

/**
 * Reconcile the process-pane transient/persisted status flags from the current
 * process map. Called after every store mutation in the provider.
 */
export function createProcessPaneSync(deps: ProcessPaneSyncDeps): () => void {
  return () => {
    const { running, crashed } = deriveProcessPaneStatus(deps.processes())
    const dir = deps.directory()
    deps.setRunning(dir, running)
    deps.setCrashed(dir, crashed)
    if (crashed) {
      // Mirror the process.crashed SSE handler: a crash learned about while the
      // pane is closed must raise the persisted attention badge so the toolbar
      // dot lights even before the pane is opened (behavior 10).
      if (!deps.isProcessOpen()) deps.setCrashedWhileClosed(true)
    } else {
      deps.setCrashedWhileClosed(false)
    }
  }
}

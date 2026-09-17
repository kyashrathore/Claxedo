import { createSignal } from "solid-js"

export type StreamKind = "cp" | "wr"

/**
 * Per-kind connectedness for the Claxedo event streams.
 *
 * Not one signal: `ClaxedoEventsProvider` runs the control-plane stream
 * (`cp`) plus one stream per workspace runtime (`wr`, over loopback for a
 * local workspace and over the relay for a remote one). The
 * `document.changed` doorbell rides `cp` only, and its consumer revalidates
 * on the `false → true` edge. An aggregate "any stream up" count goes
 * 2 → 1 → 2 when `cp` drops while a workspace stream stays up, so that edge
 * never fires and every nudge missed in the gap is lost. `centralConnected()`
 * is the `cp` bit, the revalidation edge for control-plane doorbells;
 * `connected()` keeps the any-stream meaning for consumers that want it
 * (`workbench/state/agent-status-listener.ts`).
 */
export function createStreamConnectivity() {
  const [connected, setConnected] = createSignal(false)
  const [centralConnected, setCentralConnected] = createSignal(false)
  let total = 0
  let cp = 0

  return {
    /** Any stream target is up. */
    connected,
    /** The control-plane stream (`cp`) is up — the doorbell-bearing one. */
    centralConnected,
    /**
     * One tracker per stream target, owning that stream's up/down bit. Repeated
     * calls with the same value are no-ops, so a target can report its state
     * freely (connect, heartbeat timeout, error path, teardown) without
     * double-counting.
     */
    track(kind: StreamKind) {
      let up = false
      return (value: boolean) => {
        if (up === value) return
        up = value
        const delta = value ? 1 : -1
        total += delta
        setConnected(total > 0)
        if (kind !== "cp") return
        cp += delta
        setCentralConnected(cp > 0)
      }
    },
  }
}

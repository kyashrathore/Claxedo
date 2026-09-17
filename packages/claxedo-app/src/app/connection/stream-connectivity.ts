import { createSignal } from "solid-js"

export type StreamKind = "cp" | "wr"

/**
 * Per-kind connectedness for the Claxedo event streams.
 *
 * Not one signal: `ClaxedoEventsProvider` runs the central control-plane stream
 * plus one relay-backed stream per remote workspace. The `document.changed`
 * doorbell rides the central stream only, and its consumer revalidates on the
 * `false → true` edge. An aggregate "any stream up" count goes 2 → 1 → 2 when
 * the central stream drops while a workspace stream stays up, so that edge
 * never fires and every nudge missed in the gap is lost. `centralConnected()`
 * is the revalidation edge for central-bus doorbells; `connected()` keeps the
 * any-stream meaning for consumers that want it
 * (`workbench/state/agent-status-listener.ts`).
 */
export function createStreamConnectivity() {
  const [connected, setConnected] = createSignal(false)
  const [centralConnected, setCentralConnected] = createSignal(false)
  let total = 0
  let central = 0

  return {
    /** Any stream target is up. */
    connected,
    /** The CENTRAL control-plane stream is up — the doorbell-bearing one. */
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
        central += delta
        setCentralConnected(central > 0)
      }
    },
  }
}

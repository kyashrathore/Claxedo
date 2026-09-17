import { createSignal } from "solid-js"

export type StreamKind = "cp" | "wr"

/**
 * Per-kind connectedness for the Claxedo event streams.
 *
 * Not one signal: `ClaxedoEventsProvider` runs one or two control-plane
 * streams (`cp`; a signed desktop reads its daemon's and the hosted control
 * plane's) plus the routed workspace runtime's stream (`wr`). The
 * `document.changed` doorbell rides `cp` only, and its consumer revalidates
 * on a control-plane reconnect. An aggregate "any stream up" count goes
 * 2 → 1 → 2 when `cp` drops while a workspace stream stays up, so no level
 * signal over every stream ever shows that edge — and with two control
 * planes not even a level over `cp` does, while a level that demands both up
 * would report the daemon's doorbells as down whenever the hosted plane is
 * away. So the level and the edge are separate: `centralConnected()` is
 * "some control plane is up", and `controlPlaneReconnects()` counts the
 * returns the level cannot show — a control-plane stream coming back while
 * another held the level up. A return that takes the level from down to up
 * is the level's own edge and is not counted, so a consumer revalidating on
 * both sees each outage once. `connected()` keeps the any-stream meaning for
 * consumers that want it (`workbench/state/agent-status-listener.ts`).
 */
export function createStreamConnectivity() {
  const [connected, setConnected] = createSignal(false)
  const [centralConnected, setCentralConnected] = createSignal(false)
  const [controlPlaneReconnects, setControlPlaneReconnects] = createSignal(0)
  let total = 0
  let cpUp = 0

  return {
    /** Any stream target is up. */
    connected,
    /** A control-plane stream (`cp`) is up — one of the doorbell-bearing ones. */
    centralConnected,
    /** Incremented when a control-plane stream comes back after a drop the level never showed. */
    controlPlaneReconnects,
    /**
     * One tracker per stream target, owning that stream's up/down bit. Repeated
     * calls with the same value are no-ops, so a target can report its state
     * freely (connect, heartbeat timeout, error path, teardown) without
     * double-counting. `release` retires the target (its stream is closed for
     * good): a later report from it counts for nothing.
     */
    track(kind: StreamKind) {
      let up = false
      let wasUp = false
      let tracked = true
      const set = (value: boolean) => {
        if (!tracked || up === value) return
        up = value
        const delta = value ? 1 : -1
        total += delta
        setConnected(total > 0)
        if (kind !== "cp") return
        cpUp += delta
        setCentralConnected(cpUp > 0)
        if (value && wasUp && cpUp > 1) setControlPlaneReconnects((count) => count + 1)
        if (value) wasUp = true
      }
      return Object.assign(set, {
        release() {
          if (!tracked) return
          set(false)
          tracked = false
        },
      })
    },
  }
}

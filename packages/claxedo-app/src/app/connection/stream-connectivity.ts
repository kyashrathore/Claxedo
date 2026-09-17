import { createSignal } from "solid-js"

export type StreamKind = "cp" | "wr"

/**
 * Per-kind connectedness for the Claxedo event streams.
 *
 * Not one signal: `ClaxedoEventsProvider` runs one or two control-plane
 * streams (`cp`; a signed desktop reads its daemon's and the hosted control
 * plane's) plus the routed workspace runtime's stream (`wr`). Each kind's
 * consumers revalidate on that kind's return — the `document.changed`
 * doorbell rides `cp` only; `agent.lifecycle` and `pty.*` ride `wr` only —
 * and an aggregate "any stream up" count goes 2 → 1 → 2 when one kind drops
 * while the other stays up, so no level over every stream ever shows either
 * edge. So each kind has a level: `centralConnected()` and
 * `workspaceConnected()` are "some stream of this kind is up".
 *
 * Two control planes can be open at once, and a level that demands both
 * would report the daemon's doorbells as down whenever the hosted plane is
 * away — so `cp` also has an edge counter, `controlPlaneReconnects()`,
 * counting the returns the level cannot show: a control-plane stream coming
 * back while the other held the level. A return that takes the level from
 * down to up is the level's own edge and is not counted, so a consumer
 * revalidating on both sees each outage once. `wr` needs no counter: the
 * provider closes a stale workspace stream before opening the next, so one
 * is open at a time and every return is the level's own edge. `connected()`
 * keeps the any-stream meaning.
 */
export function createStreamConnectivity() {
  const [connected, setConnected] = createSignal(false)
  const [centralConnected, setCentralConnected] = createSignal(false)
  const [workspaceConnected, setWorkspaceConnected] = createSignal(false)
  const [controlPlaneReconnects, setControlPlaneReconnects] = createSignal(0)
  let total = 0
  const up = { cp: 0, wr: 0 }
  const level = { cp: setCentralConnected, wr: setWorkspaceConnected }

  return {
    /** Any stream target is up. */
    connected,
    /** A control-plane stream (`cp`) is up — one of the doorbell-bearing ones. */
    centralConnected,
    /** The workspace runtime stream (`wr`) is up. */
    workspaceConnected,
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
      let isUp = false
      let wasUp = false
      let tracked = true
      const set = (value: boolean) => {
        if (!tracked || isUp === value) return
        isUp = value
        const delta = value ? 1 : -1
        total += delta
        setConnected(total > 0)
        up[kind] += delta
        level[kind](up[kind] > 0)
        if (kind === "cp" && value && wasUp && up.cp > 1) setControlPlaneReconnects((count) => count + 1)
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

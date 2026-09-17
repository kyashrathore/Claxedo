import { createSignal } from "solid-js"

export type StreamKind = "cp" | "wr"

/**
 * Per-kind connectedness for the Claxedo event streams.
 *
 * Not one signal: `ClaxedoEventsProvider` runs a control-plane stream (`cp`;
 * two on a signed desktop, the daemon's and the hosted control plane's) plus
 * the routed workspace runtime's stream (`wr`). The `document.changed`
 * doorbell rides `cp` only, and its consumer revalidates on the
 * `false → true` edge. An aggregate "any stream up" count goes 2 → 1 → 2 when
 * `cp` drops while a workspace stream stays up, so that edge never fires and
 * every nudge missed in the gap is lost. `centralConnected()` is true only
 * while EVERY tracked `cp` stream is up, so a drop of either control plane
 * flips it and its recovery is the revalidation edge; `connected()` keeps the
 * any-stream meaning for consumers that want it
 * (`workbench/state/agent-status-listener.ts`).
 */
export function createStreamConnectivity() {
  const [connected, setConnected] = createSignal(false)
  const [centralConnected, setCentralConnected] = createSignal(false)
  let total = 0
  let cpUp = 0
  let cpTracked = 0
  const publishCentral = () => setCentralConnected(cpTracked > 0 && cpUp === cpTracked)

  return {
    /** Any stream target is up. */
    connected,
    /** Every control-plane stream (`cp`) is up — the doorbell-bearing ones. */
    centralConnected,
    /**
     * One tracker per stream target, owning that stream's up/down bit. Repeated
     * calls with the same value are no-ops, so a target can report its state
     * freely (connect, heartbeat timeout, error path, teardown) without
     * double-counting. `release` retires the target (its stream is closed for
     * good), so a control plane that is no longer read does not hold
     * `centralConnected` down.
     */
    track(kind: StreamKind) {
      let up = false
      let tracked = true
      if (kind === "cp") {
        cpTracked += 1
        publishCentral()
      }
      const set = (value: boolean) => {
        if (!tracked || up === value) return
        up = value
        const delta = value ? 1 : -1
        total += delta
        setConnected(total > 0)
        if (kind !== "cp") return
        cpUp += delta
        publishCentral()
      }
      return Object.assign(set, {
        release() {
          if (!tracked) return
          set(false)
          tracked = false
          if (kind !== "cp") return
          cpTracked -= 1
          publishCentral()
        },
      })
    },
  }
}

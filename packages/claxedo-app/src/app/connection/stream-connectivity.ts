import { createSignal } from "solid-js"

export type StreamKind = "central" | "workspace"

/**
 * Per-kind connectedness accounting for the Claxedo event streams
 * (plan 2026-07-17-004, Wave 3).
 *
 * WHY THIS IS NOT ONE SIGNAL. `ClaxedoEventsProvider` runs several independent
 * stream targets at once: the CENTRAL control-plane stream plus one relay-backed
 * stream per remote workspace (§7 keeps those separate — cross-machine fan-in is
 * rejected). The provider used to publish a single `connected()` = "any stream is
 * up", which is an OR across targets, and every consumer read it.
 *
 * That aggregate is unusable as a revalidation trigger. The doorbells that drive
 * WorkGraph and Documents (`workgraph.changed`, `document.changed`) ride the
 * CENTRAL stream only. If the central stream drops and reconnects while any
 * workspace stream stays up, the aggregate count goes 2 → 1 → 2: it never
 * reaches 0, `connected()` never goes false, and the `false → true` edge that
 * both features use to re-establish currency NEVER FIRES. Every nudge missed
 * during that gap is lost with no recovery path — silently stale state, which is
 * exactly what plan R4 forbids and what §3 claims reconnect-revalidation covers.
 *
 * So connectedness is tracked per kind. `centralConnected()` is the correct
 * revalidation edge for anything that consumes a central-bus doorbell.
 * `connected()` keeps the old "any stream is up" meaning for consumers that
 * genuinely want it (see `workbench/state/agent-status-listener.ts`, which
 * reconciles agent status across workspace runtimes and therefore cares about
 * workspace streams too).
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
        if (kind !== "central") return
        central += delta
        setCentralConnected(central > 0)
      }
    },
  }
}

import type { ClaxedoEvent } from "../platform/runtime/lib/bus"

/**
 * SSE replay-retention policy for the CENTRAL event streams
 * (`routes/events.ts` and `routes/opencode-compat-events.ts`).
 *
 * Both read the same process-global `claxedoBus`, so a frame that one of them
 * protects from eviction and the other does not is a bug waiting to happen —
 * hence one predicate rather than a copy per handler. The compat stream wraps
 * this with its own case for `{directory, payload}` envelopes, which only IT
 * carries.
 *
 * The type-only import keeps this module free of runtime dependencies.
 */

/**
 * Frames whose loss is not self-healing.
 *
 * `createSseReplayBuffer` keeps a second, independent 64-frame ring of these, so
 * a burst of chatty frames cannot evict the one frame that settles a state
 * machine; `attachSseFanout` additionally sheds them LAST when a slow consumer
 * overflows its pending queue.
 *
 * Superset of `isTerminalBusEvent` in
 * `packages/workspace-runtime/src/routes/runtime-events.ts` (which sees the
 * narrower `WorkspaceRuntimeEvent` union), adding the frames only a central
 * stream carries:
 *
 *  - `worktree.*` and a `provision` reaching `ready`/`error` — control-plane
 *    settlements with the same "stuck spinner forever" failure mode as a lost
 *    pty exit.
 *  - `session.lifecycle` at `created`/`failed` — the ONLY notification a
 *    non-opencode/harness (ACP) session's `POST /session` emits, and the
 *    central stream is the only channel local/unsigned workspaces have for it.
 *    Losing it means the session never reaches the sidebar's inventory. The
 *    workspace stream does not need it in its terminal ring because nothing
 *    chatty competes there; on the compat central stream it competes with the
 *    native engine's token-level deltas, which is exactly what the second ring
 *    is for.
 *  - `workgraph.changed` / `document.changed` — coalesced doorbells. A lost
 *    doorbell is not self-healing by construction: the client only re-reads
 *    when nudged, so live sync stalls until the next unrelated mutation.
 */
export function isTerminalClaxedoEvent(event: ClaxedoEvent): boolean {
  switch (event.type) {
    case "pty.exited":
    case "pty.deleted":
    case "process.stopped":
    case "process.crashed":
    case "worktree.ready":
    case "worktree.failed":
    case "workgraph.changed":
    case "document.changed":
      return true
    case "pty.stream":
      return event.kind === "exit" || event.kind === "command-exit"
    case "agent.lifecycle":
      return event.eventType === "Idle" || event.eventType === "Error"
    case "session.lifecycle":
      return event.phase === "created" || event.phase === "failed"
    case "provision":
      return event.step === "ready" || event.step === "error"
    default:
      return false
  }
}

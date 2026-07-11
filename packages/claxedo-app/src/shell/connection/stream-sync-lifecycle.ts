/**
 * Streaming connection lifecycle for the live event stream
 * (`providers/claxedo-events.tsx`). The alphabet matches the real flow: a fetch
 * attempt (`connecting`), an open stream with a heartbeat armed (`live`), a
 * scheduled retry after timeout/error (`reconnect-scheduled`), and teardown
 * (`stopped`).
 *
 * The key invariant — the heartbeat timer and the reconnect timer must never be
 * armed at the same time — is made unrepresentable by {@link streamSyncArmedTimer}:
 * each state maps to exactly ONE armed timer (or none), so a caller that
 * reconciles its timers to the machine state cannot hold both. This replaces the
 * boolean-soup `{abort, heartbeatTimer, reconnectTimer, connected, stopped}`
 * where both timers could overlap (claxedo-events.tsx:231-249, :312).
 */
export type StreamSyncLifecycleState =
  | "idle"
  | "connecting"
  | "live"
  | "reconnect-scheduled"
  | "stopped"

export type StreamSyncLifecycleEvent =
  | "connect"
  | "open"
  | "heartbeat"
  | "timeout"
  | "error"
  | "retry"
  | "stop"

export const streamSyncLifecycleTransitions = {
  idle: { connect: "connecting", stop: "stopped" },
  connecting: { open: "live", error: "reconnect-scheduled", stop: "stopped" },
  live: { heartbeat: "live", timeout: "reconnect-scheduled", error: "reconnect-scheduled", stop: "stopped" },
  "reconnect-scheduled": { retry: "connecting", stop: "stopped" },
  stopped: {},
} satisfies Record<StreamSyncLifecycleState, Partial<Record<StreamSyncLifecycleEvent, StreamSyncLifecycleState>>>

export function transitionStreamSyncLifecycle(state: StreamSyncLifecycleState, event: StreamSyncLifecycleEvent) {
  return (streamSyncLifecycleTransitions as Record<
    StreamSyncLifecycleState,
    Partial<Record<StreamSyncLifecycleEvent, StreamSyncLifecycleState>>
  >)[state][event]
}

/** The single timer that is legal to have armed in a given state. Never two. */
export type StreamSyncTimer = "none" | "heartbeat" | "reconnect"

export function streamSyncArmedTimer(state: StreamSyncLifecycleState): StreamSyncTimer {
  if (state === "live") return "heartbeat"
  if (state === "reconnect-scheduled") return "reconnect"
  return "none"
}

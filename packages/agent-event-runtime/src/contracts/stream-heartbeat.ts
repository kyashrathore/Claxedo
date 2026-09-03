/**
 * The liveness contract every agent event stream shares, wherever it is served
 * (the machine's runtime on loopback, the same runtime through the relay, the
 * control plane's proxy). A producer writes a heartbeat at least this often
 * while it has nothing else to say; a consumer treats a stream that has been
 * silent for the stall budget as gone and reconnects. The budget is derived
 * from the heartbeat here so the two can never drift apart per transport.
 */
export const EVENT_STREAM_HEARTBEAT_MS = 10_000

/** Three missed heartbeats: enough to survive one late frame, short enough to notice a dead relay hop. */
export const EVENT_STREAM_STALL_MS = 3 * EVENT_STREAM_HEARTBEAT_MS

/**
 * The liveness contract every event stream shares, wherever it is served (the
 * machine's runtime on loopback, the same runtime through the relay, the
 * control plane's own stream): a producer writes a heartbeat at least this
 * often while it has nothing else to say, and a reader sizes its stall budget
 * in multiples of it.
 */
export const EVENT_STREAM_HEARTBEAT_MS = 10_000

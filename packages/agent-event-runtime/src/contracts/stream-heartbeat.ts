/**
 * How often a workspace runtime's `wr/events` and the local daemon's
 * `cp/events` write a heartbeat frame.
 */
export const EVENT_STREAM_HEARTBEAT_MS = 10_000

/**
 * How long a reader waits for any frame before it drops the stream: two
 * missed heartbeats, plus one beat of jitter for the third to arrive.
 */
export const EVENT_STREAM_STALL_TIMEOUT_MS = 4 * EVENT_STREAM_HEARTBEAT_MS

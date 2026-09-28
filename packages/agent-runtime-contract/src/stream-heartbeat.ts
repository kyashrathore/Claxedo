/**
 * How often every event stream writes a heartbeat frame: a workspace
 * runtime's `wr/events`, the local daemon's `cp/events`, and the hosted
 * `cp/events` whether it bridges a live-sync room or stands alone.
 */
export const EVENT_STREAM_HEARTBEAT_MS = 10_000

/**
 * How long a reader waits for any frame before it drops the stream: two
 * missed heartbeats, plus one beat of jitter for the third to arrive.
 */
export const EVENT_STREAM_STALL_TIMEOUT_MS = 4 * EVENT_STREAM_HEARTBEAT_MS

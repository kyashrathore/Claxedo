/**
 * How often a workspace runtime's `wr/events` and the local daemon's
 * `cp/events` write a heartbeat frame. The app's stream reader drops a stream
 * after 30 s with no frame, so a stream survives one missed heartbeat; after
 * two, the next one races the reader's deadline.
 */
export const EVENT_STREAM_HEARTBEAT_MS = 10_000

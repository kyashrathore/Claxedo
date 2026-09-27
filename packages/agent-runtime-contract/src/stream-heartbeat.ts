/**
 * The liveness contract of `wr/events`, wherever the runtime is reached (on
 * loopback, or through the relay): the producer writes a heartbeat at least
 * this often while it has nothing else to say, and the reader sizes its stall
 * budget in multiples of it (45 s, `claxedo-events-reconnect.ts`). The two
 * `cp/events` handlers beat on their own clocks against the same budget: the
 * local daemon's every 5 s (`claxedo-local-server/src/shell/events.ts`), the
 * hosted room's every 30 s (`live-sync-room.cf.ts`), which leaves that stream
 * half a heartbeat of slack before the reader reconnects.
 */
export const EVENT_STREAM_HEARTBEAT_MS = 10_000

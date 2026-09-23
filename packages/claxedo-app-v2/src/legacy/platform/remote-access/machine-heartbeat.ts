/**
 * Whether an enrolled machine's last heartbeat is recent enough to call it
 * connected.
 *
 * `claxedo connect` heartbeats every 20 seconds, so a machine three beats
 * overdue has stopped rather than been seen a moment ago.
 *
 * Derived where it is drawn rather than stored on the device row: a boolean
 * cached with the account's device list would report a machine as connected
 * for as long as that list is held, which is exactly while the user is
 * watching it.
 */
const ONLINE_WINDOW_MS = 60_000

export function heartbeatFresh(lastSeenAt: number, now = Date.now()) {
  return now - lastSeenAt < ONLINE_WINDOW_MS
}

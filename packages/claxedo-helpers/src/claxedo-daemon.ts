/**
 * The desktop's local daemon, as the processes that meet it agree on it.
 *
 * The desktop launches the daemon and publishes its discovery file, the daemon
 * refuses a caller that declares a protocol it does not serve, and the
 * `claxedo` CLI reads the file to learn whether a daemon already owns this
 * machine. Three packages hold one side each, so the values live here rather
 * than in any of them.
 */
export const CLAXEDO_DAEMON_SERVICE = "claxedo-local-daemon"

/**
 * At 3 a lease is held by the connection that acquired it and has no renewal
 * route, so a launcher speaking 2 would wait on a lease response that never
 * ends and renew one that does not exist; the daemon refuses it on the version
 * instead.
 */
export const CLAXEDO_DAEMON_PROTOCOL = 3

export const DAEMON_PROTOCOL_HEADER = "x-claxedo-daemon-protocol"

export const CLAXEDO_DAEMON_DISCOVERY_FILE = "local-daemon.json"

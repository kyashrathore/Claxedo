/**
 * The directory a session row carries, for every workspace kind.
 *
 * Every later read of that session — messages, config, agents, the transcript —
 * is scoped by this value, so it has to be an address THIS app can resolve, and
 * one answer has to hold whichever producer stamped the row (a fetched list, or
 * a `session.lifecycle`/`session.updated` frame applied by `event-ingress`).
 *
 * - The host is the server this app is attached to: `hostDirectory` is a path
 *   this app can resolve, so it is the address.
 * - The host is another machine or the provisioner: `hostDirectory` is a path
 *   on THAT machine, so every later read scoped by it would 404. The row
 *   carries `workspace:<workspaceId>` instead, reached over the registry or
 *   the relay.
 *
 * The signed `ws_*` id is what separates the two: a row that has one is
 * addressed by workspace, a row without one names a path on this machine.
 */
export function sessionRowDirectory(input: {
  workspaceId: string | undefined
  /** The path the producing runtime reported — its OWN machine's, always. */
  hostDirectory: string
}) {
  return input.workspaceId ? `workspace:${input.workspaceId}` : input.hostDirectory
}

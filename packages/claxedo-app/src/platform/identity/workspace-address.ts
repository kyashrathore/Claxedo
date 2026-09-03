/**
 * The directory a session row carries, for every workspace kind.
 *
 * Every later read of that session — messages, config, agents, the transcript —
 * is scoped by this value, so it has to be an address THIS app can resolve, and
 * one answer has to hold whichever producer stamped the row (a fetched list, or
 * a `session.created`/`session.updated` frame applied by `event-ingress`).
 *
 * - `local`: the host IS this machine, so its path is the row's directory.
 * - `cloud` and `user-hosted`: the workspace is addressed by its signed id —
 *   over the registry, or over the relay — while `hostDirectory` is a path on
 *   ANOTHER machine. Carrying it makes every later read scope itself by a
 *   directory this app cannot reach and 404, so the row carries
 *   `workspace:<workspaceId>` instead.
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

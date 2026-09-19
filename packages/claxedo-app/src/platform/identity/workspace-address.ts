/**
 * The workspace half of a model document's key: a workspace another machine or
 * the provisioner holds is its id, one this server holds is its host directory.
 * A pane and the Settings Models page must derive it the same way or they edit
 * two documents while believing they share one.
 *
 * `kind` is a free string because the two callers read it off different
 * producers — the sdk workspace states a host kind, a project-inventory row
 * states the wire word — and `local` is the only word either spells for "this
 * server". A host kind `self` reaching here would key by id instead: this
 * module sits under `platform/identity`, which cannot call the host-kind
 * narrowers in `platform/runtime` without closing a logical import cycle.
 */
export function modelStoreWorkspaceKey(input: { kind?: string; workspaceId?: string; hostDirectory: string }) {
  return input.kind && input.kind !== "local" && input.workspaceId ? input.workspaceId : input.hostDirectory
}

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

import type { RelayAccess } from "./auth"

/**
 * T26: the canonical "is this relay target user-hosted" rule.
 *
 * A user-hosted workspace runs on the user's own laptop (backing:
 * "local-worktree"); a cloud workspace runs on a dedicated cloud VM
 * (backing: "cloud-vm"). `RelayAccess` has exactly these two members, so
 * `access === "user-hosted"` and `access !== "cloud"` are equivalent — but
 * spelling the check either way at each call site invites drift if a third
 * access kind is ever added. Every caller that needs to branch on this
 * (choosing a forwarding path, tagging a socket, deciding whether to strip
 * Cookie) should go through this one predicate instead.
 */
export function isUserHostedTarget(target: { access: RelayAccess }): boolean {
  return target.access === "user-hosted"
}

export type WorkspaceRelaySocketKind = "user-hosted-client" | "client"

/**
 * The socket-kind tag applied when a relay client is admitted against
 * `target`. A user-hosted target is multiplexed over the host tunnel
 * (`"user-hosted-client"`); a cloud target gets a direct upstream socket
 * (`"client"`).
 */
export function socketKindFor(target: { access: RelayAccess }): WorkspaceRelaySocketKind {
  return isUserHostedTarget(target) ? "user-hosted-client" : "client"
}

/**
 * T26 privacy rule: never forward the browser's `Cookie` header into a
 * user-hosted workspace. Its host process runs on the user's own laptop and
 * may share a cookie jar with the browser (e.g. localhost dev tooling), so
 * passing cookies through verbatim risks leaking session data to the host.
 * Cloud-vm workspaces sit behind a dedicated network boundary where session
 * cookies may legitimately be needed (e.g. workspace dashboards), so cloud
 * targets pass `Cookie` through unchanged.
 *
 * Returns a new `Headers` instance; `headers` is not mutated.
 */
export function forwardHeadersFor(target: { access: RelayAccess }, headers: Headers): Headers {
  const forwarded = new Headers(headers)
  if (isUserHostedTarget(target)) forwarded.delete("cookie")
  return forwarded
}

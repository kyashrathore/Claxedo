import type { RelayBacking } from "./auth"

/**
 * Whether a relay target is reached through a host tunnel.
 *
 * A `local-worktree` placement runs on an enrolled machine that dials the
 * relay and multiplexes its traffic over that one socket; a `cloud-vm`
 * placement runs on the provisioner's machine, which the relay reaches by a
 * direct upstream connection.
 */
export function isHostTunnelTarget(target: { backing: RelayBacking }): boolean {
  return target.backing === "local-worktree"
}

export type WorkspaceRelaySocketKind = "host-tunnel-client" | "client"

export function socketKindFor(target: { backing: RelayBacking }): WorkspaceRelaySocketKind {
  return isHostTunnelTarget(target) ? "host-tunnel-client" : "client"
}

/**
 * Privacy rule: never forward the browser's `Cookie` header through a host
 * tunnel. The host process runs on a machine somebody uses, whose cookie jar
 * the browser may share (localhost dev tooling), so passing cookies verbatim
 * risks leaking session data to it. A cloud-vm sits behind a dedicated network
 * boundary where a session cookie may legitimately be needed, so it passes
 * `Cookie` through unchanged.
 *
 * Returns a new `Headers` instance; `headers` is not mutated.
 */
export function forwardHeadersFor(target: { backing: RelayBacking }, headers: Headers): Headers {
  const forwarded = new Headers(headers)
  if (isHostTunnelTarget(target)) forwarded.delete("cookie")
  return forwarded
}

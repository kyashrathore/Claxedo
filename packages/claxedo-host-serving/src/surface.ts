/**
 * What a remote client reaching this machine through the workspace relay
 * host tunnel (`serving.ts`) may reach on this machine for the
 * workspace it is tunneled to, and where each admitted request lands.
 *
 * The relay strips `/workspaces/:id` before forwarding. A relayed caller gets
 * ONE surface for the remaining path: `/workspaces/:id/*`, where the embedded
 * workspace runtime answers (`/session`, `/api/wr/*`, `/path`, its own
 * `/global/health` identity probe, ...). Unknown workspace routes reach the
 * runtime and return 404.
 *
 * Everything the machine answers at its own root is denied here. Those routes
 * describe the MACHINE — its identity, its provider accounts, its whole
 * project inventory, its remote-access administration — while the relay's
 * Runtime Access Token authorizes exactly one workspace and says nothing about
 * the host that happens to run it. A machine-root route that authorizes the
 * person at the keyboard cannot also be the authorization for whoever holds a
 * workspace grant, so the tunnel does not carry it at all.
 */

export type HostServingSurfaceTarget =
  | { kind: "deny" }
  | { kind: "workspace"; url: URL }

/**
 * Daemon-owned families that must never cross the tunnel, whichever
 * workspace the caller's connection is scoped to. Named against
 * `server-core/deployments/product-route-families.ts`'s family ids — every
 * entry below is owned there by `local-server` or `server`, and
 * `route-ownership.ts` classifies every one of them
 * `RouteHandler.CentralServer` or `RouteHandler.WorkspaceRelay`, never
 * `SandboxRuntime`.
 *
 * Matched the same way `route-ownership.ts` matches prefixes: an exact hit,
 * or a path segment boundary (`entry + "/"`), so `/health` does not also
 * deny a hypothetical `/healthcheck`.
 */
const DENY = [
  // Families `health` (partly — `/global/health` is re-admitted below as the
  // runtime's workspace-surface identity probe), `bootstrap`, `telemetry`,
  // `agent-config`, `credentials` (registry half), `session-meta`,
  // `local-workspace-resolve`, `network-policy`, `usage`, plus this daemon's
  // own host-serving (`/api/claxedo/host-serving`) and remote-access-machine
  // routes. All of them live under this one prefix.
  "/api/claxedo",
  // This daemon's own control-plane stream (`runtime-transport`'s
  // `/api/cp/events`): notices about the machine's own worktrees and
  // documents, for the machine's own surface, never a workspace's data.
  "/api/cp",
  // Family `session-meta`'s `/api/control` half.
  "/api/control",
  // Family `workspace-authority` (hosted `server`) and this daemon's SECOND
  // mount of the local workspace resolver at `/api/workspace`
  // (`local-app.ts` mounts `localWorkspaceRoutes` at both
  // `/api/claxedo/workspace` and `/api/workspace`).
  "/api/workspace",
  // BetterAuth device-code auth (`claxedo-server/src/routes/hosted/device-auth.ts`,
  // `self-hosted-node/app.ts`). Not mounted on this daemon today; denied
  // anyway as control-plane identity, never workspace data.
  "/api/auth",
  // The authority oracle the ISOLATED RUNTIME calls outward — served by the
  // central server, never a route a caller reaches directly
  // (`route-ownership.ts` classifies it central for the same reason: a relay
  // that could ask this daemon `/api/runtime-authority/*` could ask a laptop
  // to adjudicate its own access).
  "/api/runtime-authority",
  // The workspace-relay family itself (`route-ownership.ts`:
  // `RouteDomain.WorkspaceRelay`). A relay-delivered `path` never legitimately
  // re-enters it — the relay already stripped the `/workspaces/:id` prefix —
  // so a caller whose path still names it is exactly the nested-path
  // confusion this module's own URL-building below must not be tricked into.
  "/workspaces",
  "/host-tunnels",
  // The daemon's own liveness probe. `/global/health` — the runtime's
  // identity probe on the workspace surface — is a different path and is not
  // denied.
  "/health",
  "/.well-known",
  "/internal",
  // Families `local-config` and `credentials` — the machine's configuration
  // document and its provider accounts. `/provider/:id/oauth/callback`
  // (`local-server/credentials/routes/provider-auth.ts`) deletes this
  // machine's stored credentials for a provider and writes the caller's in
  // their place, which would point every harness on the box at an account a
  // workspace grant never mentioned. Its gate is the control-plane bearer,
  // which an unsigned desktop has no way to demand.
  "/config",
  "/provider",
  "/auth",
  // Family `project-files`' inventory half. `projectRoutes`
  // (`local-server/shell/project-routes.ts`) answers for a caller it
  // authenticates as the machine's own user when nothing signed it, so at
  // root it lists every project this machine holds — not the one workspace
  // the tunnel serves.
  "/project",
] as const

function matchesFamily(pathname: string, entry: string): boolean {
  return pathname === entry || pathname.startsWith(`${entry}/`)
}

function denied(pathname: string): boolean {
  return DENY.some((entry) => matchesFamily(pathname, entry))
}

function normalizedBase(localBaseUrl: string): string {
  return `${localBaseUrl.trim().replace(/\/+$/, "")}/`
}

/**
 * Classify one relayed request and say where it lands.
 *
 * `path` is what the tunnel hands `resolveLocalUrl` — the bare app path plus
 * its original query string, no `/workspaces/:id` prefix. The tunnel client
 * has already resolved it and refused anything that is not a path, so the
 * parse below cannot fail on a frame's raw string; a caller reaching past
 * that owner would have to answer for one itself.
 *
 * The workspace the request runs against is the one this connection is
 * tunneled to, taken from the prefix built here and never from the request.
 * A caller naming a different workspace in its own `?directory=` reaches the
 * workspace surface of the workspace its token bought, which is what the
 * per-workspace tunnel grain means.
 */
export function hostServingSurface(input: {
  localBaseUrl: string
  workspaceId: string
  path: string
}): HostServingSurfaceTarget {
  const { localBaseUrl, workspaceId, path } = input
  // Resolved once, and the RESOLVED pathname is what both the deny check and
  // the prefix below read. A denied family gains nothing from `..` — it is
  // denied in resolved form too — but an ADMITTED path pasted raw behind the
  // prefix does: `/../../session` passes the check as `/session`, then climbs
  // back out of `/workspaces/:id/` and lands on the machine's own root
  // `/session`, where the workspace comes from a caller-controlled
  // `?directory=` instead of this connection's own.
  const requested = new URL(path, "http://workspace.local")
  if (denied(requested.pathname)) return { kind: "deny" }

  const url = new URL(
    `/workspaces/${encodeURIComponent(workspaceId)}${requested.pathname}`,
    normalizedBase(localBaseUrl),
  )
  url.search = requested.search
  return { kind: "workspace", url }
}

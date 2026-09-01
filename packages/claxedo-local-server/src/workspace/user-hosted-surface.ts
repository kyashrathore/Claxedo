/**
 * What a remote client reaching this machine through the workspace relay
 * host tunnel (`user-hosted-serving.ts`) may reach on this machine for the
 * workspace it is tunneled to, and where each admitted request lands.
 *
 * This daemon composes THREE surfaces on one HTTP server, and a relay-
 * delivered request arrives with none of that structure marked on it — the
 * relay's room already strips the `/workspaces/:id` prefix before handing
 * the request to the host tunnel, so `path` here is the bare app path the
 * browser asked for (`/provider?harness=opencode`, `/session`, ...):
 *
 *   - the daemon's OWN root-level product routes — this machine's identity,
 *     credentials, and remote-access administration
 *     (`/api/claxedo/*`, `/api/control/*`, `/api/workspace/*`, ...). Never
 *     for a relayed caller: these describe the MACHINE, not the workspace it
 *     is serving, and the relay's Runtime Access Token authorizes exactly one
 *     workspace, not the host that happens to run it.
 *   - a small OpenCode-compat family mounted at that SAME root
 *     (`OpenCodeCompatRoutes`, `opencode/compat-routes/index.ts`) that
 *     answers provider auth, OAuth connect, and project metadata for
 *     whichever workspace a `?directory=`/`x-opencode-directory` names.
 *     Provider auth from a browser is a desktop capability with no other
 *     owner, so a relayed caller needs exactly what a loopback one gets.
 *   - the workspace-scoped surface `/workspaces/:id/*`, where the embedded
 *     workspace runtime answers everything else (`/session`, `/api/wr/*`,
 *     `/path`, `/provider`, its own `/global/health` identity probe, ...).
 *
 * The previous guard (`runtimeServesOnWorkspaceSurface`,
 * `server-core/platform/governance/route-ownership.ts`) modeled the daemon's
 * ROOT surface and admitted a path onto the workspace surface only if that
 * table called it runtime-owned. That is the wrong table for this question —
 * it refused `/path`, `/api/wr/worktrees`, `/api/wr/checkpoint/*`, and
 * everything else the runtime actually answers under `/workspaces/:id/*` but
 * the root table has never heard of. This module inverts the shape: DENY the
 * daemon's own families by name, and let everything else reach the workspace
 * runtime, which answers an honest 404 for what it does not implement rather
 * than a 403 from a list that was never trying to describe it.
 */

export type UserHostedSurfaceTarget =
  | { kind: "deny" }
  | { kind: "root"; url: URL }
  | { kind: "workspace"; url: URL }

/**
 * Daemon-owned families that must never cross the tunnel, whichever
 * workspace the caller's connection is scoped to. Named against
 * `server-core/deployments/product-route-families.ts`'s family ids — every
 * entry below is owned there by `local-server` or `server`, and none of them
 * is part of the OpenCode-compat family this module admits at root instead.
 *
 * Matched the same way `route-ownership.ts` matches prefixes: an exact hit,
 * or a path segment boundary (`entry + "/"`), so `/health` does not also
 * deny a hypothetical `/healthcheck`.
 */
const DENY = [
  // Families `health` (partly — `/global/health` is re-admitted below as the
  // runtime's workspace-surface identity probe), `bootstrap`, `telemetry`,
  // `agent-config`, `credentials` (registry half), `runtime-transport`'s
  // `/api/claxedo/events`, `session-meta`, `local-workspace-resolve`,
  // `network-policy`, `usage`, plus this daemon's own host-serving
  // (`/api/claxedo/host-serving`) and remote-access-machine routes. All of
  // them live under this one prefix.
  "/api/claxedo",
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
  // Disposes every cached OpenCode InstanceState the daemon holds, for every
  // workspace it serves — a daemon-wide operation, not this one workspace's
  // to trigger from across a tunnel. (It IS part of the OpenCode-compat
  // family root serves for a loopback caller; a relayed one does not get it.)
  "/global/dispose",
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
] as const

function matchesFamily(pathname: string, entry: string): boolean {
  return pathname === entry || pathname.startsWith(`${entry}/`)
}

function denied(pathname: string): boolean {
  return DENY.some((entry) => matchesFamily(pathname, entry))
}

/**
 * The OpenCode-compat family the daemon's ROOT router serves for a workspace
 * named by `?directory=`/`x-opencode-directory`
 * (`opencode/compat-routes/index.ts`), rather than the embedded workspace
 * runtime. `/provider` and `/provider/<id>` alone stay OFF this list and fall
 * through to the workspace surface below — the runtime serves the catalog
 * itself, host-injected for non-opencode harnesses — matching
 * `route-ownership.ts`'s own carve-out for the same path.
 */
function isRootCompatPath(pathname: string): boolean {
  if (pathname === "/provider/auth") return true
  if (pathname === "/config") return true
  if (pathname === "/project") return true
  if (pathname === "/project/current") return true
  // `/auth/:providerID` — PUT to connect a provider credential, DELETE to
  // remove one. Requires a segment after `/auth/`; the compat router has no
  // handler for bare `/auth`.
  if (pathname.startsWith("/auth/") && pathname.length > "/auth/".length) return true
  // `/provider/:providerID/oauth/:step`.
  if (/^\/provider\/[^/]+\/oauth\/[^/]+$/.test(pathname)) return true
  return false
}

function normalizedBase(localBaseUrl: string): string {
  return `${localBaseUrl.trim().replace(/\/+$/, "")}/`
}

/**
 * Force the workspace the ROOT compat route resolves against to be the
 * tunnel's OWN workspace, discarding whatever `directory` the request itself
 * carried.
 *
 * A relayed caller holds a connection scoped to exactly one workspace (the
 * per-workspace tunnel grain documented in `user-hosted-serving.ts`); if this
 * forwarded a caller-supplied `directory` instead, that caller could name a
 * DIFFERENT workspace id in its own query string and read that workspace's
 * `/project/current` or connect its provider credentials through THIS
 * connection's root surface — a path-confusion privilege escalation the
 * tunnel's per-workspace scoping exists to prevent.
 *
 * The bare workspace id is what the compat router actually resolves, not a
 * `workspace:<id>`-prefixed form: `resolveWorkspace({directory})`
 * (`server-core/workspace/store/index.ts`) does not parse that prefix — it
 * belongs to `session/routes/meta-routes.ts`, a different router — so a
 * prefixed value would resolve nothing. `/project/current` falls through to
 * its own "current.id === a stored project's id" fallback and answers the
 * right project on the bare id; verified live against the running daemon
 * (`GET /project/current?directory=<workspace-uuid>` returns that workspace's
 * project, `GET /config?directory=<workspace-uuid>` answers 200).
 */
function withDirectory(url: URL, workspaceId: string): URL {
  url.searchParams.set("directory", workspaceId)
  return url
}

/**
 * Classify one relayed request and say where it lands.
 *
 * `path` is what the tunnel hands `resolveLocalUrl` — the bare app path plus
 * its original query string, no `/workspaces/:id` prefix.
 */
export function userHostedSurface(input: {
  localBaseUrl: string
  workspaceId: string
  path: string
}): UserHostedSurfaceTarget {
  const { localBaseUrl, workspaceId, path } = input
  const pathname = new URL(path, "http://workspace.local").pathname
  if (denied(pathname)) return { kind: "deny" }

  const base = normalizedBase(localBaseUrl)
  const suffix = path.replace(/^\/+/, "")

  if (isRootCompatPath(pathname)) {
    return { kind: "root", url: withDirectory(new URL(`/${suffix}`, base), workspaceId) }
  }
  return { kind: "workspace", url: new URL(`/workspaces/${encodeURIComponent(workspaceId)}/${suffix}`, base) }
}

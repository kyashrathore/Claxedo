/**
 * Product route families for the mixed `deployments/local` composition.
 *
 * `createApp` currently serves TWO products from one route table: the
 * desktop-local server that Electron starts as a loopback sidecar, and the
 * self-hosted signed single-binary that `package.json` `start` and the
 * Dockerfile ship. Nothing in the code says which route belongs to which — the
 * separation lives only in reviewers' heads, which is exactly why the package
 * split cannot be checked today.
 *
 * This table says it. Every mounted path is assigned to one family, and every
 * family names the package that will own it after the split. The contract tests
 * beside this file then have a discriminating gate: adding a route without
 * claiming an owner fails, and so does moving a route to the wrong product.
 *
 * `owner` is the TARGET owner, not today's producer — today's producer is
 * `deployments/local/server.ts` for all of them. The units that make each
 * target real are named per family.
 */

export type RouteFamilyOwner =
  /** Moves to `@claxedo/local-server` (Unit 5). */
  | "local-server"
  /** Stays in `@claxedo/server`'s shared signed control plane (Units 7–8). */
  | "server"
  /** Moves to `@claxedo/host-connector` (Unit 6). */
  | "host-connector"

export type RouteFamily = {
  /** Stable family ID used by the contract tests and by Units 5 and 7. */
  id: string
  owner: RouteFamilyOwner
  /** What the family serves, in product terms. */
  serves: string
  /**
   * Path prefixes and exact paths, as Hono registers them (`:param` intact).
   * A prefix entry ends with `/`; everything else must match exactly.
   */
  paths: string[]
}

/**
 * Ordered most-specific-first. `/api/claxedo/agent-config/` must be tested
 * before a hypothetical `/api/claxedo/` catch-all would be, and
 * `/api/workspace/:id/user-hosted/` before `/api/workspace/`.
 */
export const PRODUCT_ROUTE_FAMILIES: RouteFamily[] = [
  // ── Desktop-local: the closure Electron's sidecar must reproduce ──────────
  {
    id: "health",
    owner: "local-server",
    serves: "Liveness and authenticated daemon identity for desktop, plus the container health check.",
    paths: ["/api/claxedo/health", "/api/claxedo/daemon", "/global/health"],
  },
  {
    id: "bootstrap",
    owner: "local-server",
    serves: "The one shell-bootstrap payload the renderer reads before its first route.",
    paths: ["/api/claxedo/bootstrap"],
  },
  {
    id: "telemetry",
    owner: "local-server",
    serves: "The renderer's capture relay; the local product owns its own telemetry sink.",
    paths: ["/api/claxedo/track"],
  },
  {
    id: "agent-config",
    owner: "local-server",
    serves: "Harness selection, agents, commands, MCP servers, and extensions from the local profile.",
    paths: ["/api/claxedo/agent-config", "/api/claxedo/agent-config/"],
  },
  {
    id: "credentials",
    owner: "local-server",
    serves: "Local provider credential storage, discovery, verification, and provider OAuth.",
    paths: [
      "/api/claxedo/credentials",
      "/api/claxedo/credentials/",
      "/provider",
      "/provider/",
      "/provider/*",
      "/auth/:providerID",
      "/config/providers",
    ],
  },
  {
    id: "local-config",
    owner: "local-server",
    serves: "The local configuration document the settings surfaces read and write.",
    paths: ["/config", "/global/config"],
  },
  {
    id: "runtime-transport",
    owner: "local-server",
    serves: "Workspace Runtime HTTP/SSE/PTY adaptation and the shell event stream — the local execution data path.",
    paths: ["/api/wr/", "/api/claxedo/events", "/workspaces/:workspaceId", "/workspaces/:workspaceId/"],
  },
  {
    id: "project-files",
    owner: "local-server",
    serves: "Project, file, diff, search, VCS, LSP, worktree, and process surfaces backed by Workspace Runtime.",
    paths: [
      "/project",
      "/project/",
      "/file",
      "/file/",
      "/find",
      "/find/",
      "/path",
      "/vcs",
      "/lsp",
      "/agent",
      "/command",
      "/question",
      "/session/status",
      "/mcp",
      "/mcp/",
      "/experimental/worktree",
      "/experimental/worktree/",
      "/global/event",
      "/global/dispose",
    ],
  },
  {
    id: "session-meta",
    owner: "local-server",
    serves: "Local session inventory and title metadata; Unit 4 moves its authority into Workspace Runtime.",
    paths: ["/api/claxedo/session", "/api/claxedo/session/", "/api/claxedo/session-list", "/api/control", "/api/control/"],
  },
  {
    id: "local-workspace-resolve",
    owner: "local-server",
    serves: "Local workspace registration and lookup without importing hosted workspace authority.",
    paths: ["/api/claxedo/workspace", "/api/claxedo/workspace/resolve"],
  },
  {
    id: "network-policy",
    owner: "local-server",
    serves: "Local egress policy groups applied to harness and sandbox traffic.",
    paths: ["/api/claxedo/network-policy", "/api/claxedo/network-policy/"],
  },
  {
    id: "usage",
    owner: "local-server",
    serves: "Unified local, cross-machine, external history, and provider quota usage projection.",
    paths: ["/api/claxedo/usage", "/api/claxedo/usage/"],
  },

  // ── Hosted control plane: stays in @claxedo/server ────────────────────────
  {
    id: "jwks",
    owner: "server",
    serves: "Published verification keys for Runtime and Host tunnel tokens.",
    paths: ["/.well-known/jwks.json"],
  },
  {
    id: "workspace-authority",
    owner: "server",
    serves: "Workspace records, roles, shares, drivers, checkpoints, lifecycle, and connection mint.",
    paths: ["/api/workspace", "/api/workspace/"],
  },
  {
    id: "relay-authority",
    owner: "server",
    serves: "The authenticated Relay target, revocation resolver, and runtime session authority channels.",
    paths: ["/api/runtime-authority/", "/internal/relay/"],
  },
  {
    id: "documents",
    owner: "server",
    serves: "Documents storage, snapshots, runtime jobs, and the local installation broker.",
    paths: ["/documents", "/documents/", "/internal/documents/"],
  },
  {
    id: "connections",
    owner: "server",
    serves: "Hosted integration connections, OAuth attempts, tokens, and webhook secrets.",
    paths: ["/api/claxedo/integrations", "/api/claxedo/integrations/"],
  },
  {
    id: "channels",
    owner: "server",
    serves: "Channel ingress webhooks and device pairing.",
    paths: ["/api/channels", "/api/channels/"],
  },
  {
    id: "project-remote",
    owner: "server",
    serves: "Repository/remote metadata resolved through a hosted code-host connection.",
    paths: ["/api/claxedo/project/remote"],
  },

  // ── Host publication: moves to @claxedo/host-connector ───────────────────
  {
    id: "remote-access",
    owner: "host-connector",
    serves: "Machine enrollment, device listing, and second-device open for user-hosted workspaces.",
    paths: ["/api/claxedo/remote-access", "/api/claxedo/remote-access/"],
  },
]

/**
 * Hono registers a bare `ALL /*` for global middleware. It is not a route
 * family; classifying it would make every family look like it owned everything.
 */
export function isMiddlewareRoute(path: string) {
  return path === "/*" || path === "*"
}

export function routeFamilyFor(path: string): RouteFamily | null {
  let best: RouteFamily | null = null
  let bestLength = -1
  for (const family of PRODUCT_ROUTE_FAMILIES) {
    for (const entry of family.paths) {
      const matched = entry.endsWith("/") ? path.startsWith(entry) : path === entry || path === `${entry}/*`
      if (!matched) continue
      if (entry.length > bestLength) {
        best = family
        bestLength = entry.length
      }
    }
  }
  return best
}

/** Distinct, non-middleware paths a Hono app actually serves. */
export function mountedPaths(routes: { path: string }[]) {
  return [...new Set(routes.map((route) => route.path).filter((path) => !isMiddlewareRoute(path)))].toSorted()
}

export function pathsByOwner(routes: { path: string }[], owner: RouteFamilyOwner) {
  return mountedPaths(routes)
    .filter((path) => routeFamilyFor(path)?.owner === owner)
    .toSorted()
}

export function unclassifiedPaths(routes: { path: string }[]) {
  return mountedPaths(routes).filter((path) => !routeFamilyFor(path))
}

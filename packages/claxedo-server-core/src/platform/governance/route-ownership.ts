export const RouteDomain = {
  AgentExtensions: "agent-extensions",
  // Agent Config Registry is a sibling of AgentExtensions covering canonical
  // agent-config / credentials registry surfaces (MCP config, slash commands,
  // agent profile, secrets registry). Tests in `workspace/runtime-dispatch/route-ownership-contract.test.ts` classify
  // `/api/claxedo/agent-config`, `/api/claxedo/credentials`,
  // `/api/wr/config`, `/api/wr/harness-config-options`, `/mcp`, `/agent`,
  // `/command` under this domain.
  AgentConfigRegistry: "agent-config-registry",
  AgentSessionRuntime: "agent-session-runtime",
  Channels: "channels",
  SandboxRuntime: "sandbox-manager-runtime",
  ClaxedoControlPlane: "claxedo-control-plane",
  WorkspaceRelay: "workspace-relay",
} as const

export type RouteDomain = (typeof RouteDomain)[keyof typeof RouteDomain]

export const RouteHandler = {
  CentralServer: "central-server",
  SandboxRuntime: "sandbox-manager-runtime",
  WorkspaceRelay: "workspace-relay",
  Unclaimed: "unclaimed",
} as const

export type RouteHandler = (typeof RouteHandler)[keyof typeof RouteHandler]

type RouteRule = {
  paths: readonly string[]
  match: "exact" | "prefix"
  domain: RouteDomain
  handler: Exclude<RouteHandler, "unclaimed">
  phase?: string
}

export type RouteOwnership =
  | {
      domain: RouteDomain
      handler: Exclude<RouteHandler, "unclaimed">
      phase?: string
    }
  | {
      handler: typeof RouteHandler.Unclaimed
    }

const exact = (
  paths: readonly string[],
  domain: RouteDomain,
  handler: Exclude<RouteHandler, "unclaimed">,
  phase?: string,
): RouteRule => ({
  paths,
  match: "exact",
  domain,
  handler,
  phase,
})

const prefix = (
  paths: readonly string[],
  domain: RouteDomain,
  handler: Exclude<RouteHandler, "unclaimed">,
  phase?: string,
): RouteRule => ({
  paths,
  match: "prefix",
  domain,
  handler,
  phase,
})

const central = RouteHandler.CentralServer
const runtime = RouteHandler.SandboxRuntime
const relay = RouteHandler.WorkspaceRelay

const ROUTE_RULES = [
  exact(["/health"], RouteDomain.WorkspaceRelay, relay),
  prefix(["/workspaces", "/host-tunnels"], RouteDomain.WorkspaceRelay, relay),
  prefix(["/api/channels"], RouteDomain.Channels, central),
  exact(["/.well-known/jwks.json"], RouteDomain.ClaxedoControlPlane, central),
  prefix(["/internal/relay"], RouteDomain.WorkspaceRelay, central),
  prefix(["/internal/workgraph"], RouteDomain.ClaxedoControlPlane, central),
  exact(
    [
      "/global/health",
      "/global/dispose",
      "/path",
      "/api/claxedo/health",
      "/api/claxedo/track",
      "/api/claxedo/bootstrap",
    ],
    RouteDomain.ClaxedoControlPlane,
    central,
  ),
  exact(["/global/config"], RouteDomain.AgentConfigRegistry, central),
  prefix(["/api/claxedo/remote-access"], RouteDomain.ClaxedoControlPlane, central),
  // `/provider` itself is served by the workspace runtime for every
  // workspace-scoped caller (the control plane proxies it; a relayed
  // user-hosted request reaches the laptop's runtime). Listed BEFORE the
  // prefix rule below because first match wins, and listed EXACT so
  // `/provider/auth` and `/provider/<id>/oauth/*` stay central — the runtime
  // implements neither. Same shape as `/command`.
  //
  // Reclassifying flips `runtimeOwned("/provider")` on the Node roots, which
  // routes a workspace-scoped request to the embedded runtime instead of the
  // compat router; the runtime answers non-opencode harnesses through the
  // host-injected `providerCatalog`, so both paths serve one catalog.
  exact(
    ["/provider"],
    RouteDomain.AgentConfigRegistry,
    runtime,
    "Workspace-scoped provider catalog is served by workspace-runtime (host-injected for non-opencode harnesses); unscoped compatibility and /provider/* auth flows stay central.",
  ),
  prefix(
    ["/config", "/provider", "/auth", "/api/claxedo/agent-config", "/api/claxedo/credentials"],
    RouteDomain.AgentConfigRegistry,
    central,
  ),
  // `/command` has central no-directory OpenCode compatibility in
  // OpenCodeCompatRoutes, but workspace-scoped cloud/Relay requests can still
  // route to workspace-runtime. Keep the static ownership classifier aligned
  // with that runtime-routed path while the canonical command-management API
  // remains the Agent Config Registry.
  exact(
    ["/command"],
    RouteDomain.AgentConfigRegistry,
    runtime,
    "Workspace-scoped command compatibility can route through workspace-runtime; canonical command management is Agent Config Registry.",
  ),
  prefix(
    [
      "/project",
      "/api/claxedo/session",
      "/api/control",
      "/api/workspace",
      // Authority oracle the isolated runtime CALLS; it is served by the
      // central server / Worker, never proxied to a runtime. Classifying it
      // central keeps proxy.ts from forwarding an authority question to the
      // very runtime whose access it is meant to adjudicate.
      "/api/runtime-authority",
      "/api/claxedo/network-policy",
      "/documents",
      "/api/workgraph",
    ],
    RouteDomain.ClaxedoControlPlane,
    central,
  ),
  exact(["/experimental/session"], RouteDomain.AgentSessionRuntime, runtime),
  prefix(["/experimental"], RouteDomain.ClaxedoControlPlane, central),
  prefix(["/api/wr/hook"], RouteDomain.SandboxRuntime, runtime),
  exact(["/global/event", "/api/wr/events", "/api/wr/runtime-events"], RouteDomain.SandboxRuntime, runtime),
  exact(["/api/wr/health", "/api/wr/capabilities"], RouteDomain.SandboxRuntime, runtime),
  exact(
    ["/api/wr/config", "/api/wr/harness-config-options"],
    RouteDomain.AgentConfigRegistry,
    runtime,
    "Phase 2 moves canonical config ownership fully into Agent Config Registry.",
  ),
  prefix(
    ["/api/wr/pty", "/api/wr/process", "/api/wr/diff", "/api/wr/git", "/api/wr/session-env", "/find", "/file"],
    RouteDomain.SandboxRuntime,
    runtime,
  ),
  exact(["/lsp", "/vcs"], RouteDomain.SandboxRuntime, runtime),
  prefix(["/session", "/permission", "/question", "/event"], RouteDomain.AgentSessionRuntime, runtime),
  prefix(
    ["/mcp"],
    RouteDomain.AgentConfigRegistry,
    runtime,
    "Local compatibility path; canonical MCP ownership is Agent Config Registry and signed/cloud callers use Claxedo-owned routes or Relay.",
  ),
  exact(
    ["/agent"],
    RouteDomain.AgentConfigRegistry,
    runtime,
    "Local compatibility path; canonical agent profile ownership is Agent Config Registry / harness adapters and signed/cloud callers do not use this path.",
  ),
] as const satisfies readonly RouteRule[]

function matches(pathname: string, rule: RouteRule) {
  if (rule.match === "exact") return rule.paths.includes(pathname)
  return rule.paths.some((item) => pathname === item || pathname.startsWith(item + "/"))
}

/**
 * The runtime's identity probe. The control plane verifies every read it
 * makes through a relay with this path first — the answer must name the
 * workspace it asked for — before trusting the runtime it reached.
 */
export const WORKSPACE_RUNTIME_IDENTITY_PATH = "/global/health"

export function routeOwnership(pathname: string): RouteOwnership {
  const rule = ROUTE_RULES.find((item) => matches(pathname, item))
  if (!rule) {
    return {
      handler: RouteHandler.Unclaimed,
    }
  }
  return {
    domain: rule.domain,
    handler: rule.handler,
    ...(rule.phase ? { phase: rule.phase } : {}),
  }
}

export function routeRules() {
  return ROUTE_RULES
}

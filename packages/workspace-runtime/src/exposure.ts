import type { MiddlewareHandler } from "hono"
import type { RelayHostAuthContext, RelayHostAuthOptions } from "./workspace-host-service-auth"

/** Hop-only header stamped by `@claxedo/local-server` `embedded()` for author attribution. */
export const EMBEDDED_RELAY_HOST_AUTH_HEADER = "x-claxedo-embedded-relay-host-auth"

export type WorkspaceRuntimeRequestGuard = (input: {
  request: Request
  path: string
  method: string
}) => boolean | Response | void | Promise<boolean | Response | void>

export type WorkspaceRuntimeExposure =
  | { kind: "loopback" }
  | { kind: "relay"; auth: RelayHostAuthOptions }
  | {
      kind: "private-network"
      protection: { kind: "host-guard"; name: string; guard: WorkspaceRuntimeRequestGuard }
      runtimeAuth: WorkspaceRuntimeRequestGuard
    }
  | {
      kind: "private-network"
      protection: { kind: "dev-unsafe"; reason: string }
      runtimeAuth: { kind: "dev-unsafe" }
    }
  | {
      kind: "embedded"
      owner: string
      middleware: "caller-owned"
      guard: WorkspaceRuntimeRequestGuard
    }

export function loopbackWorkspaceRuntimeExposure(): WorkspaceRuntimeExposure {
  return { kind: "loopback" }
}

export function relayWorkspaceRuntimeExposure(auth: RelayHostAuthOptions): WorkspaceRuntimeExposure {
  return { kind: "relay", auth }
}

export function privateNetworkDevUnsafeWorkspaceRuntimeExposure(reason: string): WorkspaceRuntimeExposure {
  return {
    kind: "private-network",
    protection: {
      kind: "dev-unsafe",
      reason,
    },
    runtimeAuth: { kind: "dev-unsafe" },
  }
}

export function privateNetworkWorkspaceRuntimeExposure(input: {
  name: string
  guard: WorkspaceRuntimeRequestGuard
  runtimeAuth: WorkspaceRuntimeRequestGuard
}): WorkspaceRuntimeExposure {
  return {
    kind: "private-network",
    protection: {
      kind: "host-guard",
      name: input.name,
      guard: input.guard,
    },
    runtimeAuth: input.runtimeAuth,
  }
}

export function embeddedWorkspaceRuntimeExposure(input: {
  owner: string
  guard: WorkspaceRuntimeRequestGuard
}): WorkspaceRuntimeExposure {
  return {
    kind: "embedded",
    owner: input.owner,
    middleware: "caller-owned",
    guard: input.guard,
  }
}

export function exposureBoundaryName(exposure: WorkspaceRuntimeExposure) {
  if (exposure.kind === "private-network") {
    return exposure.protection.kind === "dev-unsafe" ? "private-network-dev-unsafe" : "private-network-host-guard"
  }
  return exposure.kind
}

export function assertWorkspaceRuntimeExposure(input: {
  exposure: WorkspaceRuntimeExposure | undefined
  hostname?: string
  isLoopbackHostname?: (hostname: string) => boolean
  env?: Pick<NodeJS.ProcessEnv, "NODE_ENV">
}) {
  if (!input.exposure) throw new Error("Workspace runtime exposure is required")
  if (input.exposure.kind === "loopback" && input.hostname && input.isLoopbackHostname && !input.isLoopbackHostname(input.hostname)) {
    throw new Error(`Refusing loopback workspace runtime exposure on non-loopback host ${input.hostname}`)
  }
  if (input.exposure.kind === "relay" && !input.exposure.auth) {
    throw new Error("Workspace runtime relay exposure requires relay auth")
  }
  if (input.exposure.kind === "embedded" && typeof input.exposure.guard !== "function") {
    throw new Error("Workspace runtime embedded exposure requires a caller-owned guard")
  }
  if (
    input.exposure.kind === "private-network"
    && input.exposure.protection.kind === "host-guard"
    && typeof input.exposure.protection.guard !== "function"
  ) {
    throw new Error("Workspace runtime private-network exposure requires a host guard")
  }
  if (
    input.exposure.kind === "private-network"
    && input.exposure.protection.kind === "host-guard"
    && typeof input.exposure.runtimeAuth !== "function"
  ) {
    throw new Error("Workspace runtime private-network exposure requires runtime auth")
  }
  if (
    input.exposure.kind === "private-network"
    && input.exposure.protection.kind === "dev-unsafe"
    && (input.env?.NODE_ENV === "production" || input.env?.NODE_ENV === "test")
  ) {
    throw new Error("Workspace runtime dev-unsafe private-network exposure is not allowed in production or test")
  }
}

export function createWorkspaceRuntimeExposureMiddleware(exposure: WorkspaceRuntimeExposure): MiddlewareHandler {
  return async (c, next) => {
    const guard = exposure.kind === "embedded"
      ? exposure.guard
      : exposure.kind === "private-network" && exposure.protection.kind === "host-guard"
        ? exposure.protection.guard
        : undefined
    const request = {
      request: c.req.raw,
      path: c.req.path,
      method: c.req.method,
    }
    const result = guard ? await guard(request) : undefined
    if (result instanceof Response) return result
    if (result === false) {
      return c.json({
        error: {
          code: "workspace_runtime_exposure_denied",
          message: "Workspace runtime exposure guard denied the request",
        },
      }, 403)
    }
    if (exposure.kind === "embedded") {
      const stamped = parseEmbeddedRelayHostAuth(c.req.header(EMBEDDED_RELAY_HOST_AUTH_HEADER))
      if (stamped) {
        ;(c as unknown as { set(name: "relayHostAuth", value: RelayHostAuthContext["relayHostAuth"]): void })
          .set("relayHostAuth", stamped)
      }
    }
    if (exposure.kind === "private-network" && exposure.protection.kind === "host-guard") {
      const runtimeAuth = typeof exposure.runtimeAuth === "function"
        ? await exposure.runtimeAuth(request)
        : false
      if (runtimeAuth instanceof Response) return runtimeAuth
      if (runtimeAuth === false) {
        return c.json({
          error: {
            code: "workspace_runtime_auth_denied",
            message: "Workspace runtime auth denied the request",
          },
        }, 401)
      }
    }
    return await next()
  }
}

function parseEmbeddedRelayHostAuth(value: string | undefined): RelayHostAuthContext["relayHostAuth"] {
  if (!value?.trim()) return
  try {
    const parsed = JSON.parse(value) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return
    const row = parsed as Record<string, unknown>
    const actor_id = stringValue(row.actor_id)
    const actor_kind = row.actor_kind === "human" || row.actor_kind === "agent" ? row.actor_kind : undefined
    const actor_public_id = stringValue(row.actor_public_id)
    const actor_name = stringValue(row.actor_name)
    const workspace_id = stringValue(row.workspace_id)
    const org_id = stringValue(row.org_id)
    const role = row.role === "viewer" || row.role === "editor" || row.role === "admin" || row.role === "owner"
      ? row.role
      : undefined
    if (!actor_id || !actor_kind || !actor_public_id || !actor_name || !workspace_id || !org_id || !role) return
    return {
      actor_id,
      actor_kind,
      actor_public_id,
      actor_name,
      ...(stringValue(row.actor_avatar_url) ? { actor_avatar_url: stringValue(row.actor_avatar_url) } : {}),
      workspace_id,
      org_id,
      role,
      ...(stringValue(row.host_id) ? { host_id: stringValue(row.host_id) } : {}),
      // Attribution-only: chips need author; do not flip local embedded policy
      // into managed-private session authority (no registerSession there).
      attribution_only: true,
      access: "user-hosted",
      backing: "local-worktree",
      iss: "workspace-relay",
      aud: "workspace-host-service",
      sub: actor_id,
      exp: Math.floor(Date.now() / 1000) + 60,
      iat: Math.floor(Date.now() / 1000),
      jti: `embedded_${actor_public_id}`,
    } as RelayHostAuthContext["relayHostAuth"]
  } catch {
    return
  }
}

function stringValue(input: unknown) {
  return typeof input === "string" && input.trim() ? input.trim() : undefined
}

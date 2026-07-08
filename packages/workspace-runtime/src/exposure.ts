import type { MiddlewareHandler } from "hono"
import type { RelayHostAuthOptions } from "./workspace-host-service-auth"

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

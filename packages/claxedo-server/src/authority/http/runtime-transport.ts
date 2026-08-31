import type { Workspace } from "@claxedo/server-core/workspace/store/index"
import type { WorkspaceRecord } from "@claxedo/server-core/platform/auth/authority"
import type { ControlPlaneAuthContext } from "@claxedo/server-core/platform/auth/auth"
import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { ControlPlaneServices } from "../services"
import { ControlPlaneProtocolError, txt, type ControlPlaneHttpOptions } from "./protocol"
import { resolveWorkspaceRuntimeTarget } from "../runtime-target"
import { resolveRuntimeActor } from "@claxedo/server-core/platform/auth/runtime-actor"
import type { RelayRole } from "@claxedo/workspace-relay"

export function runtimePath(path: string, query?: Record<string, string | undefined>) {
  const url = new URL(path, "http://workspace-runtime.local")
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value)
  }
  return `${url.pathname}${url.search}`
}

export async function verifiedRuntimeJson<T>(
  services: ControlPlaneServices,
  options: ControlPlaneHttpOptions,
  input: {
    workspaceId: string
    ws: Workspace
    authorityWorkspace?: WorkspaceRecord
    authorityRole?: RelayRole
    auth?: ControlPlaneAuthContext
    path: string
  },
) {
  const health = await runtimeJson<Record<string, unknown>>(services, options, {
    ...input,
    path: "/global/health",
  })
  if (txt(health.workspaceId) !== input.workspaceId) {
    throw new ControlPlaneProtocolError(
      409,
      "workspace_runtime_mismatch",
      "Workspace runtime identity does not match requested workspace",
    )
  }
  return await runtimeJson<T>(services, options, input)
}

export async function runtimeJson<T>(
  services: ControlPlaneServices,
  options: ControlPlaneHttpOptions,
  input: {
    workspaceId: string
    ws: Workspace
    authorityWorkspace?: WorkspaceRecord
    authorityRole?: RelayRole
    auth?: ControlPlaneAuthContext
    path: string
  },
) {
  const res = await runtimeFetch(services, options, {
    ...input,
    init: { headers: { accept: "application/json" } },
  })
  if (res.ok) return (await res.json()) as T
  throw new ControlPlaneProtocolError(
    res.status,
    "workspace_runtime_pull_failed",
    (await res.text().catch(() => "")) || `Workspace runtime pull failed: ${res.status}`,
  )
}

async function runtimeFetch(
  services: ControlPlaneServices,
  options: ControlPlaneHttpOptions,
  input: {
    workspaceId: string
    ws: Workspace
    authorityWorkspace?: WorkspaceRecord
    authorityRole?: RelayRole
    auth?: ControlPlaneAuthContext
    path: string
    init?: RequestInit
  },
) {
  if (options.runtimeFetch) return await options.runtimeFetch(input)
  const target = await resolveWorkspaceRuntimeTarget(services, input.auth, {
    workspaceId: input.workspaceId,
    ...(input.authorityWorkspace ? { workspace: input.authorityWorkspace } : {}),
  })
  const provider = services.relay.provider
  if (!provider) {
    throw new ControlPlaneProtocolError(
      503,
      "workspace_runtime_unavailable",
      "Workspace runtime pull transport is not configured",
    )
  }
  const orgId = input.ws.org_id
  if (!orgId) {
    throw new ControlPlaneProtocolError(
      409,
      "workspace_org_required",
      "Workspace is missing org identity for runtime token minting",
    )
  }
  if (input.auth?.mode === "signed" && !input.authorityRole) {
    throw new ControlPlaneProtocolError(
      403,
      "workspace_authorization_denied",
      "Workspace role is required for runtime token minting",
    )
  }
  const token = await provider.mintRuntimeAccessToken({
    workspaceId: input.workspaceId,
    hostId: target.hostId,
    subject: input.auth?.mode === "signed" ? input.auth.user.subject : "control-plane",
    principalKind: input.auth?.mode === "signed" ? "user" : "service",
    ...(input.auth?.mode === "signed"
      ? await resolveRuntimeActor(requireAuthority(services), input.auth)
      : { actorId: "control-plane", actorKind: "agent" as const }),
    orgId,
    role: input.auth?.mode === "signed" ? input.authorityRole! : "owner",
    ttlMs: 10 * 60_000,
  })
  const relayUrl = await provider.getRelayEndpoint(input.workspaceId, target.homeRegion)
  const headers = new Headers(input.init?.headers)
  headers.set("authorization", `Bearer ${token.token}`)
  headers.set("x-opencode-directory", `workspace:${input.workspaceId}`)
  return await fetch(
    `${relayUrl.replace(/\/+$/, "")}/workspaces/${encodeURIComponent(input.workspaceId)}${input.path}`,
    {
      ...input.init,
      headers,
    },
  )
}

import { defaultHomeRegion, normalizeClaxedoRegion } from "../../platform/runtime/region"
import type { Workspace } from "../../workspace/store"
import type { ControlPlaneAuthContext } from "../../platform/auth/auth"
import type { ControlPlaneServices } from "../services"
import { ControlPlaneProtocolError, txt, type ControlPlaneHttpOptions } from "./protocol"

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
    auth?: ControlPlaneAuthContext
    path: string
  },
) {
  const health = await runtimeJson<Record<string, unknown>>(services, options, {
    ...input,
    path: "/api/wr/health",
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
    auth?: ControlPlaneAuthContext
    path: string
    init?: RequestInit
  },
) {
  if (options.runtimeFetch) return await options.runtimeFetch(input)
  const hostManager = services.sandbox.sandboxManager
  if (!hostManager) {
    throw new ControlPlaneProtocolError(503, "sandbox_unavailable", "Sandbox manager is not configured")
  }
  const target = await hostManager.target(input.workspaceId).catch(() => undefined)
  if (target?.status !== "ready") {
    throw new ControlPlaneProtocolError(409, "cloud_runtime_unavailable", "Cloud runtime is unavailable")
  }
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
  const token = await provider.mintRuntimeAccessToken({
    workspaceId: input.workspaceId,
    hostId: target.hostId,
    subject: input.auth?.mode === "signed" ? input.auth.user.subject : "control-plane",
    orgId,
    role: "owner",
    ttlMs: 10 * 60_000,
  })
  const relayUrl = await provider.getRelayEndpoint(
    input.workspaceId,
    normalizeClaxedoRegion(target.homeRegion, services.defaultHomeRegion ?? defaultHomeRegion()),
  )
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

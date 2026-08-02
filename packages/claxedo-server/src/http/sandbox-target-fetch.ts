import type { SandboxManager } from "@claxedo/sandbox-manager"
import type { Workspace } from "../workspace/store"
import { normalizeClaxedoRegion, type ClaxedoRegion } from "../region"
import type { RelayProvider, RelayTokenInput } from "../adapters/relay"

export type SandboxFetchOptions = {
  sandboxManager?: SandboxManager
  relayProvider?: RelayProvider
  loopbackRelayUrl?: string
  defaultHomeRegion?: ClaxedoRegion
  subject?: string
  orgId?: string
  role?: RelayTokenInput["role"]
  /** Inspect an already-ready runtime without waking or reprovisioning it. */
  resume?: boolean
}

export async function sandboxFetch(
  ws: Workspace,
  path: string,
  init?: RequestInit,
  options: SandboxFetchOptions = {},
) {
  if (ws.kind !== "cloud") {
    const embeddedMod = "../deployments/local/embedded-workspace-runtime"
    const { ensureEmbeddedWorkspaceRuntime } = await import(/* @vite-ignore */ embeddedMod)
    const runtime = await ensureEmbeddedWorkspaceRuntime(ws)
    return runtime.app.fetch(new Request(new URL(path, "http://embedded-workspace-runtime.local"), init))
  }
  if (options.loopbackRelayUrl && !options.relayProvider) {
    const headers = new Headers(init?.headers)
    headers.set("x-opencode-directory", `workspace:${ws.id}`)
    headers.set("accept-encoding", "identity")
    return fetch(
      `${options.loopbackRelayUrl.replace(/\/+$/, "")}/workspaces/${encodeURIComponent(ws.id)}${sandboxPath(path)}`,
      {
        ...init,
        headers,
      },
    )
  }
  const target = await sandboxTarget(ws, options)
  if (!options.relayProvider) {
    throw new Error(`workspace relay provider unavailable: ${ws.id}`)
  }
  const orgId = options.orgId ?? ws.org_id
  if (!orgId) {
    throw new Error(`workspace org required for runtime token minting: ${ws.id}`)
  }
  const token = await options.relayProvider.mintRuntimeAccessToken({
    workspaceId: ws.id,
    hostId: target.hostId,
    subject: options.subject ?? "control-plane",
    orgId,
    role: options.role ?? "owner",
    ttlMs: 10 * 60_000,
  })
  const relayUrl = await options.relayProvider.getRelayEndpoint(
    ws.id,
    normalizeClaxedoRegion(target.homeRegion, options.defaultHomeRegion ?? "us-east"),
  )
  const headers = new Headers(init?.headers)
  headers.set("authorization", `Bearer ${token.token}`)
  headers.set("x-opencode-directory", `workspace:${ws.id}`)
  headers.set("accept-encoding", "identity")
  return fetch(`${relayUrl.replace(/\/+$/, "")}/workspaces/${encodeURIComponent(ws.id)}${sandboxPath(path)}`, {
    ...init,
    headers,
  })
}

async function sandboxTarget(ws: Workspace, options: SandboxFetchOptions) {
  if (!options.sandboxManager) {
    throw new Error(`sandbox manager unavailable: ${ws.id}`)
  }
  const target = options.resume === false
    ? await options.sandboxManager.target(ws.id)
    : await options.sandboxManager.ensure(ws.id, { homeRegion: options.defaultHomeRegion ?? "us-east" })
  if (target.status === "ready") return target
  if (target.status === "provisioning") {
    throw new Error(`sandbox provisioning; retry after ${target.retryAfterMs}ms`)
  }
  const reason = "reason" in target ? target.reason : target.error
  throw new Error(reason ?? `sandbox unavailable: ${ws.id}`)
}

function sandboxPath(path: string) {
  const url = new URL(path, "http://sandbox-manager.local")
  return `${url.pathname}${url.search}`
}

import type { SandboxManager } from "@claxedo/sandbox-manager"
import type { Workspace } from "@claxedo/server-core/workspace/store/index"
import { normalizeClaxedoRegion, type ClaxedoRegion } from "@claxedo/server-core/platform/runtime/region/index"
import type { RelayProvider, RelayTokenInput } from "../../adapters/relay/index"

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

/**
 * How to reach a LOCAL workspace's runtime.
 *
 * This used to be a dynamic import of the local deployment written as a
 * variable with `@vite-ignore`, which made a shared module reach back into the
 * product it belongs beneath — in a form neither TypeScript nor an import-graph
 * walker can see. The composition that owns an embedded runtime installs this;
 * one that has none never asks for a local workspace.
 */
export type LocalWorkspaceRuntimeFetch = (ws: Workspace, request: Request) => Promise<Response>

let localRuntimeFetch: LocalWorkspaceRuntimeFetch | undefined

export function configureLocalWorkspaceRuntimeFetch(fetchLocal: LocalWorkspaceRuntimeFetch | undefined) {
  localRuntimeFetch = fetchLocal
}

export async function sandboxFetch(
  ws: Workspace,
  path: string,
  init?: RequestInit,
  options: SandboxFetchOptions = {},
) {
  if (ws.kind !== "cloud") {
    if (!localRuntimeFetch) {
      throw new Error(
        `no local workspace runtime configured; call configureLocalWorkspaceRuntimeFetch from the composition that owns one (workspace ${ws.id})`,
      )
    }
    return localRuntimeFetch(ws, new Request(new URL(path, "http://embedded-workspace-runtime.local"), init))
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

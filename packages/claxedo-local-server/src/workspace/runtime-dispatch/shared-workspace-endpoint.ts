/**
 * The relay-shaped `/workspaces/:workspaceId/*` surface on a local server.
 *
 * Local browser clients use this path for workspace-scoped streams and APIs.
 * Relay-backed cloud workspaces use the same path, but are forwarded after a
 * loopback-only trust check and an owner runtime token mint.
 */

import type { Context } from "hono"
import { resolveWorkspace } from "@claxedo/server-core/workspace/store/index"
import { isLoopbackLocalRequest } from "@claxedo/server-core/platform/http/peer-address"
import { errorBody } from "@claxedo/server-core/platform/http/http"
import {
  embedded,
  ensureCloudRuntime,
  noWr,
  proxy,
  type RuntimeProxyOptions,
} from "./internals"

const DEFAULT_REMOTE_DIRECTORY = "/workspace"

export function createLocalWorkspaceRelayProxy(options: RuntimeProxyOptions = {}) {
  return (c: Context) => localWorkspaceRelayProxyWithOptions(c, options)
}

export async function localWorkspaceRelayProxy(c: Context): Promise<Response> {
  return localWorkspaceRelayProxyWithOptions(c)
}

async function localWorkspaceRelayProxyWithOptions(c: Context, options: RuntimeProxyOptions = {}): Promise<Response> {
  if (!isLoopbackLocalRequest(c.req.raw)) {
    return c.json(errorBody("workspace_relay_local_loopback_required", "Local workspace relay proxy requires loopback access"), 401)
  }
  const workspaceId = c.req.param("workspaceId")
  if (!workspaceId) return c.json(errorBody("workspace_relay_workspace_required", "workspaceId is required"), 400)
  const ws = await resolveWorkspace({ workspaceId })
  if (!ws) return c.json(errorBody("workspace_relay_workspace_not_found", "Workspace not found"), 404)

  try {
    const pathname = new URL(c.req.url).pathname.replace(/^\/workspaces\/[^/]+/, "") || "/"
    if (ws.kind !== "cloud") return await embedded(c, ws, pathname)

    const runtime = await ensureCloudRuntime(ws, options)
    const current = await resolveWorkspace({ workspaceId: ws.id }) ?? ws
    const hit = {
      workspaceId: ws.id,
      workspaceName: current.workspace_name || current.project_name || current.repo_name || undefined,
      directory: current.remote_directory || DEFAULT_REMOTE_DIRECTORY,
      url: runtime.url,
      ...(runtime.relay ? { relay: runtime.relay } : {}),
    }
    return await proxy(c, hit, {
      pathname,
      forwardedBy: "workspace-relay",
      sandboxManager: options.sandboxManager,
      ...(options.relayProvider ? { relayProvider: options.relayProvider } : {}),
      ...(options.defaultHomeRegion ? { defaultHomeRegion: options.defaultHomeRegion } : {}),
    })
  } catch (error) {
    return noWr(c, error)
  }
}

/**
 * The `/workspaces/:workspaceId/*` surface on the LOCAL server.
 *
 * The old name (`localWorkspaceRelayProxy`) said the opposite of what this
 * does: it is not proxying TO a relay, it IS the relay-shaped surface for a
 * shared local workspace. It answers the same URL shape the hosted relay
 * serves, which is what lets a user share a local workspace for remote access
 * — the `user-hosted` value of a workspace's three-way `access`.
 *
 * SECURITY: for a relay-backed workspace this path mints a
 * `subject:"control-plane"`, `role:"owner"` Relay Host Token on the caller's
 * behalf, and the ONLY thing gating that mint is `isLoopbackLocalRequest` at
 * the top of the handler. It fails closed on forwarded headers and checks peer
 * address, host and origin. Moving the mint ahead of that gate, or relaxing the
 * gate to trust a forwarded claim, hands out owner tokens to anything that can
 * reach the port. `shared-workspace-endpoint.test.ts` pins both the refusal
 * ordering and the successful forward.
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
} from "@claxedo/local-server/workspace/runtime-dispatch/internals"

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
  if (!ws) {
    return c.json(errorBody("workspace_relay_workspace_not_found", "Workspace not found"), 404)
  }
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
      // `proxy()` mints the Relay Host Token this cloud runtime demands ONLY
      // when the hit carries `relay` (see the mint branch there). Dropping it
      // here — as this inline hit used to, unlike `resolveWorkspaceHit` which
      // forwards it — meant every request the browser sent through this
      // loopback proxy reached the runtime carrying the USER's bearer token
      // instead of a relay token, and came back 401 `relay_host_token_required`
      // / `invalid_relay_token`. On a loopback server URL this proxy is the
      // path the app actually takes for a relay-backed workspace
      // (`workspace-runtime-request.ts:223`), so a local cloud workspace could
      // never finish connecting: the gate sat on "Preparing workspace" forever.
      ...(runtime.relay ? { relay: runtime.relay } : {}),
    }
    return await proxy(c, hit, {
      pathname,
      forwardedBy: "workspace-relay",
      sandboxManager: options.sandboxManager,
      ...(options.relayProvider ? { relayProvider: options.relayProvider } : {}),
      ...(options.defaultHomeRegion ? { defaultHomeRegion: options.defaultHomeRegion } : {}),
    })
  } catch (err) {
    return noWr(c, err)
  }
}

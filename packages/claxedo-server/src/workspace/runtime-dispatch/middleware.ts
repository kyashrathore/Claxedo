/**
 * The global fall-through: any request whose path the ownership registry marks
 * `SandboxRuntime` is dispatched to that workspace's runtime instead of being
 * handled here. Mounted with `app.use` (not as a route) at
 * `deployments/local/server.ts`, so it sees every request and passes on the
 * ones it does not own — no control-plane endpoint is ever dispatched.
 *
 * Two strategies, chosen by where the workspace runs:
 *   - EMBEDDED  — a local workspace, handled in-process with no network hop
 *   - FORWARD   — a cloud workspace, fetched over the relay or straight to the
 *                 sandbox
 *
 * The sibling entrypoint (`shared-workspace-endpoint.ts`) is a mounted ROUTE
 * with its own loopback gate. Keeping them apart is the point of the split:
 * they share machinery but not a trust boundary.
 */

import type { Context, Next } from "hono"
import { resolveWorkspace } from "../store"
import {
  embedded,
  noWr,
  proxy,
  requestWorkspace,
  resolveWorkspaceHit,
  runtimeOwned,
  type RuntimeProxyOptions,
} from "./internals"

export function createWorkspaceRuntimeProxy(options: RuntimeProxyOptions = {}) {
  return (c: Context, next: Next) => workspaceRuntimeProxyWithOptions(c, next, options)
}

export async function workspaceRuntimeProxy(c: Context, next: Next): Promise<Response | void> {
  return workspaceRuntimeProxyWithOptions(c, next)
}

async function workspaceRuntimeProxyWithOptions(
  c: Context,
  next: Next,
  options: RuntimeProxyOptions = {},
): Promise<Response | void> {
  const pathname = new URL(c.req.url).pathname

  if (!runtimeOwned(pathname)) return next()

  try {
    const input = requestWorkspace(c)
    const ws = await resolveWorkspace({
      workspaceId: input.workspaceId,
      directory: input.directory,
    })
    if (!ws) return next()
    if (ws.kind !== "cloud") return await embedded(c, ws)
    const hit = await resolveWorkspaceHit(ws, options)
    if (!hit) return next()
    return await proxy(c, hit, {
      sandboxManager: options.sandboxManager,
      ...(options.relayProvider ? { relayProvider: options.relayProvider } : {}),
      ...(options.defaultHomeRegion ? { defaultHomeRegion: options.defaultHomeRegion } : {}),
    })
  } catch (err) {
    return noWr(c, err)
  }
}

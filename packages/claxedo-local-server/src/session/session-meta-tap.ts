import type { MiddlewareHandler } from "hono"
import { resolveWorkspace } from "@claxedo/server-core/workspace/store/index"
import type { SessionProjectionStore } from "@claxedo/server-core/authority/session-projection"

/**
 * Records local session metadata as sessions are created, renamed, and deleted.
 *
 * The control plane — not the harness — is the source of truth for the session
 * list on local workspaces, so the shell can list sessions without asking a
 * harness anything. This taps the PROXIED response rather than the request,
 * which is why it must be registered before the workspace runtime proxy: the
 * proxy answers `/session` itself, so a middleware registered after it never
 * sees the call.
 *
 * Cloud workspaces are skipped — those are owned by the workspace authority.
 *
 * Best-effort by construction: recording never blocks the response and never
 * changes it. A failure here costs a stale session list, not a failed request.
 */
export function sessionMetaProjectionTap(
  projectionStore: Pick<SessionProjectionStore, "put_session_meta" | "delete_session_meta">,
): MiddlewareHandler {
  return async (c, next) => {
    await next()
    try {
      const url = new URL(c.req.url)
      const method = c.req.method
      const sessionMatch = url.pathname.match(/^\/session\/([^/]+)$/)
      const isCreate = method === "POST" && url.pathname === "/session"
      const isUpdate = method === "PATCH" && !!sessionMatch
      const isDelete = method === "DELETE" && !!sessionMatch
      if (!isCreate && !isUpdate && !isDelete) return
      const res = c.res
      if (!res || res.status < 200 || res.status >= 300) return
      const rawDir = c.req.query("directory") || c.req.header("x-opencode-directory") || undefined
      const directory = rawDir ? decodeURIComponent(rawDir) : undefined
      const workspaceId =
        c.req.query("workspaceId") || c.req.query("workspace") || c.req.header("x-workspace-id") || undefined
      const ws = await resolveWorkspace({ workspaceId, directory }).catch(() => undefined)
      // Cloud sessions are owned by the Convex control plane.
      if (ws?.kind === "cloud") return
      if (isDelete) {
        const sessionId = sessionMatch?.[1]
        if (!sessionId) return
        await projectionStore.delete_session_meta(decodeURIComponent(sessionId))
        return
      }
      const body = (await res
        .clone()
        .json()
        .catch(() => undefined)) as Record<string, any> | undefined
      if (!body || typeof body.id !== "string") return
      await projectionStore.put_session_meta(body.id, {
        ws: ws ?? undefined,
        directory: ws?.directory ?? directory ?? (typeof body.directory === "string" ? body.directory : null),
        title: typeof body.title === "string" ? body.title : null,
        parentID: typeof body.parentID === "string" ? body.parentID : null,
        archived: typeof body?.time?.archived === "number" ? body.time.archived : null,
      })
    } catch {
      // best-effort: never break the proxied response
    }
  }
}

/**
 * The SSE half of the same concern.
 *
 * A harness session's auto-generated title — OpenCode's own LLM rename, or an
 * ACP harness's post-turn `maybeEmitTitle` — is published ONLY on that
 * workspace's `/global/event` stream. It never arrives as an HTTP
 * `PATCH /session/:id`, so the response tap above cannot see it, and without
 * this projection titles revert to "Untitled" after a restart.
 */
export async function projectLocalSessionMetaFromEvent(
  projectionStore: Pick<SessionProjectionStore, "sync_session_meta">,
  event: {
    directory?: string
    payload: { properties?: Record<string, unknown> } & Record<string, unknown>
  },
) {
  try {
    const raw = event.payload.properties?.info
    const info = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined
    if (!info || typeof info.id !== "string") return
    const directory = typeof info.directory === "string" ? info.directory : event.directory
    const workspaceID = typeof info.workspaceID === "string" ? info.workspaceID : undefined
    const ws = await resolveWorkspace({ workspaceId: workspaceID, directory }).catch(() => undefined)
    if (ws?.kind === "cloud") return
    await projectionStore.sync_session_meta(ws, {
      ...info,
      ...(directory ? { directory } : {}),
    })
  } catch {
    // Best-effort projection; upstream events must never break the bridge.
  }
}

import { Hono } from "hono"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { ControlPlaneAuthError, controlPlaneAuthErrorBody } from "@claxedo/server-core/platform/auth/auth"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import { sessionReaderCommandSchema } from "@claxedo/server-core/session/reader-contract"
import { ClaxedoError } from "@claxedo/server-core/platform/errors/base"
import type { ControlPlaneEvent } from "@claxedo/server-core/platform/runtime/lib/bus"
import { notifySessionReaderChanged } from "../notify-session-state"

export function createSessionReaderRoutes(options: {
  authenticate(request: Request): Promise<SignedControlPlaneAuth | Response>
  authority: Pick<WorkspaceAuthority, "writeSessionReader" | "listSessionStateNotices">
  notice(event: ControlPlaneEvent): Promise<unknown>
  now?: () => number
}) {
  return new Hono().post("/sessions/:sessionId/reader", async (c) => {
    const auth = await options.authenticate(c.req.raw)
    if (auth instanceof Response) return auth
    const workspaceId = c.req.query("workspaceId")
    const command = sessionReaderCommandSchema.safeParse(await c.req.json().catch(() => undefined))
    if (!workspaceId || !command.success) return c.json({ error: { code: "invalid_session_reader_command" } }, 400)
    if (!options.authority.writeSessionReader || !options.authority.listSessionStateNotices) return c.json({ error: { code: "session_reader_unavailable" } }, 503)
    try {
      const result = await options.authority.writeSessionReader(auth, { sessionId: c.req.param("sessionId"), workspaceId, command: command.data })
      if (result.ok) await notifySessionReaderChanged({ auth, authority: options.authority,
        ref: { sessionId: c.req.param("sessionId"), workspaceId }, reader: result.state,
        sink: options.notice?.bind(options), now: (options.now ?? Date.now)() })
      return c.json(result, result.ok ? 200 : 409)
    } catch (error) {
      if (error instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(error), error.status)
      if (error instanceof ClaxedoError) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status })
      throw error
    }
  })
}

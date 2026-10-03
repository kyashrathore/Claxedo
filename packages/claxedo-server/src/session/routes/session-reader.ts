import { Hono, type Context } from "hono"
import { ControlPlaneAuthError, controlPlaneAuthErrorBody, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { SessionReaderAuthority } from "@claxedo/server-core/platform/auth/session-reader-authority"
import type { SessionReaderChangedEvent } from "@claxedo/server-core/platform/runtime/lib/bus"
import { sessionReaderWrite, type SessionReaderAction } from "@claxedo/server-core/session/reader"

/**
 * `POST /sessions/:sessionId/seen` and `/settle`: the signed caller's own
 * marks, written whether or not the session's machine is online, and rung to
 * the caller's room. A ring that fails is logged and the committed write
 * still answers.
 */
export function createSessionReaderRoutes(options: {
  authenticate(request: Request): Promise<SignedControlPlaneAuth | Response>
  authority(): SessionReaderAuthority
  publish(auth: SignedControlPlaneAuth, event: SessionReaderChangedEvent): Promise<unknown>
}) {
  const write = (action: SessionReaderAction) => async (c: Context) => {
    try {
      const auth = await options.authenticate(c.req.raw)
      if (auth instanceof Response) return auth
      const input = sessionReaderWrite(action, await c.req.json().catch(() => undefined))
      if (!input) return c.json({ error: { code: "invalid_input", message: `Invalid ${action} body` } }, 400)
      const sessionId = c.req.param("sessionId")!
      const recorded = await options.authority().recordSessionReader(auth, { sessionId, write: input })
      if (!recorded) return c.json({ error: { code: "SESSION_NOT_FOUND", message: "Session not found" } }, 404)
      const { workspaceId, ...state } = recorded
      const event = { type: "session.reader.changed", ownerUserId: auth.user.subject, sessionId, workspaceId, ...state, ts: Date.now() } as const
      await options.publish(auth, event).catch((error: unknown) => console.error("[claxedo-server] WARN  session.reader.changed publish failed:", error))
      return c.json(state)
    } catch (error) {
      if (error instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(error), error.status)
      throw error
    }
  }
  return new Hono()
    .post("/sessions/:sessionId/seen", write("seen"))
    .post("/sessions/:sessionId/settle", write("settle"))
}

import { Hono } from "hono"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { ControlPlaneAuthError, controlPlaneAuthErrorBody } from "@claxedo/server-core/platform/auth/auth"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import { ClaxedoError } from "@claxedo/server-core/platform/errors/base"
import { parseSessionAttentionPageQuery } from "@claxedo/server-core/session/attention-query"

export function createSessionAttentionRoutes(options: {
  authenticate(request: Request): Promise<SignedControlPlaneAuth | Response>
  authority: Pick<WorkspaceAuthority, "listSessionAttention">
}) {
  return new Hono().get("/session-attention", async (c) => {
    const auth = await options.authenticate(c.req.raw)
    if (auth instanceof Response) return auth
    const query = parseSessionAttentionPageQuery({ after: c.req.query("after"), limit: c.req.query("limit") })
    if (!query) {
      return c.json({ error: { code: "invalid_session_attention_page" } }, 400)
    }
    if (!options.authority.listSessionAttention) return c.json({ error: { code: "session_attention_unavailable" } }, 503)
    try {
      return c.json(await options.authority.listSessionAttention(auth, query))
    } catch (error) {
      if (error instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(error), error.status)
      if (error instanceof ClaxedoError) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status })
      throw error
    }
  })
}

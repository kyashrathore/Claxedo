import { Hono } from "hono"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { ControlPlaneAuthError, controlPlaneAuthErrorBody } from "@claxedo/server-core/platform/auth/auth"
import type { AccountSessionAttentionPage } from "@claxedo/server-core/platform/auth/session-attention-authority"
import { ClaxedoError } from "@claxedo/server-core/platform/errors/base"
import { listLocalSessionAttention } from "@claxedo/server-core/session/attention-ledger"
import { parseSessionAttentionPageQuery } from "@claxedo/server-core/session/attention-query"

export function createLocalSessionAttentionRoutes(options: {
  authenticate(request: Request): Promise<SignedControlPlaneAuth | undefined | Response>
  listSigned?: (auth: SignedControlPlaneAuth, input: { after: number; limit: number }) => Promise<AccountSessionAttentionPage>
}) {
  return new Hono().get("/api/claxedo/session-attention", async (c) => {
    try {
      const auth = await options.authenticate(c.req.raw)
      if (auth instanceof Response) return auth
      const query = parseSessionAttentionPageQuery({ after: c.req.query("after"), limit: c.req.query("limit") })
      if (!query) {
        return c.json({ error: { code: "invalid_session_attention_page" } }, 400)
      }
      if (auth && !options.listSigned) return c.json({ error: { code: "session_attention_unavailable" } }, 503)
      const page = auth ? await options.listSigned!(auth, query) : listLocalSessionAttention(query)
      return c.json(page)
    } catch (error) {
      if (error instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(error), error.status)
      if (error instanceof ClaxedoError) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status })
      throw error
    }
  })
}

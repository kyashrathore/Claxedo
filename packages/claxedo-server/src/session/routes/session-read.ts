import { Hono, type Context } from "hono"
import {
  AgentMessagePageError, TurnPageQueryError, parseMessagePageQuery,
  parseOlderTurnPageQuery, parseTurnPageQuery,
  type AgentMessagePageInput, type TurnPageQuery,
} from "@claxedo/agent-runtime-contract"
import { ControlPlaneAuthError, controlPlaneAuthErrorBody, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import { asRecord } from "@claxedo/server-core/platform/json/index"
import { contentfulStatus } from "../../platform/http/status"

type SessionAt = { sessionId: string; workspaceId?: string }
export type SessionReadPort<Principal> = {
  messages(auth: Principal, input: SessionAt & { page?: AgentMessagePageInput }): Promise<unknown>
  firstRead(auth: Principal, input: SessionAt & { firstPage?: TurnPageQuery }): Promise<unknown>
  page(auth: Principal, input: SessionAt & { page: TurnPageQuery & { before: string } }): Promise<unknown>
  part(auth: Principal, input: SessionAt & { messageId: string; partId: string }): Promise<{ part?: unknown } | undefined>
}

export function authoritySessionReads(authority: Pick<WorkspaceAuthority, "readSessionMessages" | "readSessionFirstRead" | "readSessionPage" | "readSessionPart">): SessionReadPort<SignedControlPlaneAuth> {
  return {
    messages: async (auth, input) => {
      const body = await authority.readSessionMessages(auth, { sessionId: input.sessionId, workspaceId: input.workspaceId!, ...input.page })
      return asRecord(body)?.allowed === false ? undefined : body
    },
    firstRead: (auth, input) => authority.readSessionFirstRead(auth, { ...input, workspaceId: input.workspaceId! }),
    page: (auth, input) => authority.readSessionPage(auth, { ...input, workspaceId: input.workspaceId! }),
    part: (auth, input) => authority.readSessionPart(auth, { ...input, workspaceId: input.workspaceId! }),
  }
}

export function createSessionReadRoutes<Principal>(options: {
  authenticate(request: Request, workspaceId: string | undefined): Promise<Principal | Response>
  reads: SessionReadPort<Principal>
}) {
  const app = new Hono()
  const notFound = () => Response.json({ error: { code: "SESSION_NOT_FOUND", message: "Session not found" } }, { status: 404 })
  const read = async (c: Context, run: (auth: Principal, at: SessionAt) => Promise<Response>) => {
    try {
      const workspaceId = c.req.query("workspaceId")
      const auth = await options.authenticate(c.req.raw, workspaceId)
      if (auth instanceof Response) return auth
      return await run(auth, { sessionId: c.req.param("sessionId")!, ...(workspaceId ? { workspaceId } : {}) })
    } catch (error) {
      if (error instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(error), error.status)
      if (error instanceof TurnPageQueryError) return c.json({ error: { code: "turn_page_query_error", message: error.message } }, 400)
      if (error instanceof AgentMessagePageError) return c.json({ error: { code: "message_page_error", message: error.message } }, contentfulStatus(error.status))
      throw error
    }
  }
  app.get("/sessions/:sessionId/messages", (c) => read(c, async (auth, at) => {
    const page = parseMessagePageQuery(c.req.query("limit"), c.req.query("before"), c.req.query("view"))
    const body = await options.reads.messages(auth, { ...at, ...(page ? { page } : {}) })
    if (body === undefined) return notFound()
    const cursor = messagePageCursor(body)
    if (cursor) {
      c.header("Access-Control-Expose-Headers", "X-Next-Cursor")
      c.header("X-Next-Cursor", cursor)
    }
    return c.json(body)
  }))
  app.get("/sessions/:sessionId/outline", (c) => read(c, async (auth, at) => {
    const firstPage = parseTurnPageQuery((name) => c.req.query(name))
    const body = await options.reads.firstRead(auth, { ...at, ...(firstPage ? { firstPage } : {}) })
    return body === undefined ? notFound() : c.json(body)
  }))
  app.get("/sessions/:sessionId/page", (c) => read(c, async (auth, at) => {
    const page = parseOlderTurnPageQuery((name) => c.req.query(name))
    const body = await options.reads.page(auth, { ...at, page })
    return body === undefined ? notFound() : c.json(body)
  }))
  app.get("/sessions/:sessionId/part", (c) => read(c, async (auth, at) => {
    const body = await options.reads.part(auth, { ...at, ...parseSessionPartInput(c.req.query("messageId"), c.req.query("partId")) })
    if (body === undefined) return notFound()
    if (!body.part) return c.json({ error: { code: "part_not_found", message: "The session has no such part" } }, 404)
    return c.json({ part: body.part })
  }))
  return app
}

function parseSessionPartInput(messageId: string | undefined, partId: string | undefined): { messageId: string; partId: string } {
  if (!messageId || !partId) throw new AgentMessagePageError(400, "messageId and partId are required")
  return { messageId, partId }
}

function messagePageCursor(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined
  const cursor = (body as { nextCursor?: unknown }).nextCursor
  return typeof cursor === "string" && cursor.length > 0 ? cursor : undefined
}

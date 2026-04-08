import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { parseSessionMeta, putSessionMeta, sessionMeta } from "../session-meta"
import { resolveWorkspace } from "../workspace-store"

async function workspace(c: {
  req: {
    query: (k: string) => string | undefined
    header: (k: string) => string | undefined
  }
}) {
  const hit = await resolveWorkspace({
    workspaceId: c.req.query("workspaceId") || c.req.query("workspace") || c.req.header("x-workspace-id"),
    directory: c.req.query("directory") || c.req.header("x-opencode-directory"),
  })
  if (hit) return hit
}

export function SessionMetaRoutes() {
  return new Hono()
    .get("/api/claxedo/session/:id/meta", async (c) => {
      const hit = await sessionMeta(c.req.param("id"))
      if (!hit) return c.json({ sessionID: c.req.param("id"), tags: [], attachments: [] })
      return c.json(hit)
    })
    .put("/api/claxedo/session/:id/meta", async (c) => {
      const body = await c.req.json().catch(() => ({}))
      const next = parseSessionMeta(body)
      const ws = await workspace(c).catch(() => undefined)
      if (!Object.keys(next).length && !ws) {
        throw new HTTPException(400, { message: "session metadata update is empty" })
      }
      await putSessionMeta(c.req.param("id"), {
        ws,
        ...next,
      })
      return c.json(await sessionMeta(c.req.param("id")) ?? { sessionID: c.req.param("id"), tags: [], attachments: [] })
    })
}

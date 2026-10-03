import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { sessionMetaLocations } from "@claxedo/server-core/session/meta/index"
import { resolveWorkspace } from "@claxedo/server-core/workspace/store/index"

type Options = {
  authenticate: (request: Request) => Promise<SignedControlPlaneAuth | undefined | Response>
  authorize: (auth: SignedControlPlaneAuth, ref: { sessionId: string; workspaceId: string }) => Promise<void>
}

export function createLocalSessionLocationRoutes(options: Options) {
  return new Hono().get("/api/claxedo/session/:id/location", async (c) => {
    const auth = await options.authenticate(c.req.raw)
    if (auth instanceof Response) return auth
    const sessionId = c.req.param("id")
    const expectedWorkspaceId = c.req.query("workspaceId")
    if (expectedWorkspaceId !== undefined && !expectedWorkspaceId.trim()) {
      throw new HTTPException(400, { message: "Workspace id is empty" })
    }
    const locations = sessionMetaLocations(sessionId)
    if (locations.length !== 1) throw new HTTPException(404, { message: "Session location not found" })
    const workspaceId = locations[0].workspaceId
    if (!workspaceId || expectedWorkspaceId !== undefined && expectedWorkspaceId !== workspaceId) {
      throw new HTTPException(404, { message: "Session location not found" })
    }
    if (auth) await options.authorize(auth, { sessionId, workspaceId })
    const workspace = await resolveWorkspace({ workspaceId })
    if (!workspace || workspace.kind !== "local" || !workspace.project_id) {
      throw new HTTPException(404, { message: "Local session location not found" })
    }
    return c.json({ sessionId, workspaceId, projectId: workspace.project_id })
  })
}

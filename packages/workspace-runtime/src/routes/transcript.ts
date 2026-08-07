import { Hono } from "hono"
import type { TranscriptResolution } from "../transcript-resolver"

export function TranscriptRoutes(input: {
  workspaceId: string
  resolver: {
    open(request: {
      workspaceId: string
      parentSessionId: string
      handle: string
    }): Promise<TranscriptResolution>
  }
}) {
  return new Hono().get("/:handle", async (context) => {
    const parentSessionId = context.req.query("parentSessionId")
    if (!parentSessionId) return context.json({ state: "unavailable", reason: "missing-parent" } satisfies TranscriptResolution, 400)
    context.header("Cache-Control", "no-store")
    return context.json(await input.resolver.open({
      workspaceId: input.workspaceId,
      parentSessionId,
      handle: context.req.param("handle"),
    }))
  })
}

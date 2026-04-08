import { Hono } from "hono"
import { Log } from "../log"

const log = Log.create({ service: "config-route" })

export type RuntimeRunner = {
  type: "claude-acp" | "codex-acp" | "cursor-acp" | "opencode"
  binary?: string
  model?: string
}

export type RuntimeSnapshot = {
  version: 1
  mcp: Record<string, unknown>
  runner: RuntimeRunner
  auth: Record<string, string>
}

export const ConfigRoutes = (apply: (snapshot: RuntimeSnapshot) => Promise<void>) =>
  new Hono().post("/api/wr/config", async (c) => {
    const body = await c.req.json<RuntimeSnapshot>().catch(() => null)
    if (!body || body.version !== 1 || !body.runner?.type || typeof body.auth !== "object" || typeof body.mcp !== "object") {
      return c.json({ error: "Invalid runtime snapshot" }, 400)
    }
    try {
      await apply(body)
      log.info("Applied runtime snapshot", {
        runner: body.runner.type,
        model: body.runner.model,
      })
      return c.json({ ok: true })
    } catch (err) {
      log.error("Failed to apply runtime snapshot", {
        error: err instanceof Error ? err.message : String(err),
      })
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
    }
  })

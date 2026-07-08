import { Hono } from "hono"
import { errorBody } from "./http"
import { timingSafeEqualStrings } from "../control-plane/web-crypto"
import type { ControlPlaneTelemetry } from "../control-plane/services"
import type { SandboxManager } from "@claxedo/sandbox-manager"

export type HostedSandboxAdminOptions = {
  adminToken?: string
  sandboxManager?: SandboxManager
  telemetry?: ControlPlaneTelemetry
}

function clean(input: string | undefined) {
  const value = input?.trim()
  return value ? value : undefined
}

function authorized(request: Request, expected: string | undefined) {
  const header = request.headers.get("authorization")
  if (!expected || !header) return false
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  const presented = match?.[1]?.trim()
  return presented ? timingSafeEqualStrings(presented, expected) : false
}

function capture(options: HostedSandboxAdminOptions, event: string, properties: Record<string, unknown>) {
  try {
    options.telemetry?.capture("system", event, properties)
  } catch {
    // Admin telemetry must never break the manual operation itself.
  }
}

export function HostedSandboxAdminRoutes(options: HostedSandboxAdminOptions = {}) {
  const app = new Hono()

  app.use("/internal/sandbox-manager/*", async (c, next) => {
    if (!authorized(c.req.raw, clean(options.adminToken))) {
      return c.json(errorBody("sandbox_admin_unauthorized", "Sandbox admin routes require a matching bearer token"), 401)
    }
    await next()
  })

  app.post("/internal/sandbox-manager/gc", async (c) => {
    if (!options.sandboxManager) {
      return c.json(errorBody("sandbox_unavailable", "Cloud sandbox is not configured"), 501)
    }
    const result = await options.sandboxManager.garbageCollect()
    capture(options, "sandbox.garbage_collect", {
      destroyed: result.destroyed.length,
      kept: result.kept.length,
      skipped: result.skipped.length,
      failed: result.failed.length,
    })
    return c.json(result)
  })

  app.post("/internal/sandbox-manager/release", async (c) => {
    if (!options.sandboxManager) {
      return c.json(errorBody("sandbox_unavailable", "Cloud sandbox is not configured"), 501)
    }
    const body = await c.req.json().catch(() => undefined) as { workspaceId?: unknown } | undefined
    const workspaceId = clean(typeof body?.workspaceId === "string" ? body.workspaceId : undefined)
    if (!workspaceId) {
      return c.json(errorBody("sandbox_admin_invalid_request", "Releasing a sandbox lease requires a workspaceId"), 400)
    }
    const result = await options.sandboxManager.release(workspaceId)
    capture(options, "sandbox.release", {
      workspaceId,
      released: result.released,
    })
    return c.json(result)
  })

  return app
}

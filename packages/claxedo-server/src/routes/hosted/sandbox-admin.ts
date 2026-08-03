import { cleanString as clean } from "../../platform/runtime/lib/strings"
import { Hono } from "hono"
import { errorBody } from "../../platform/http/http"
import type { ControlPlaneTelemetry } from "../../authority/services"
import type { SandboxManager } from "@claxedo/sandbox-manager"
import { internalAdminAuthorized } from "../../platform/http/internal-admin-auth"
import { emitSandboxLeaseClosed } from "../../platform/telemetry/product/metering"

export type HostedSandboxAdminOptions = {
  adminToken?: string
  sandboxManager?: SandboxManager
  telemetry?: ControlPlaneTelemetry
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
    if (!internalAdminAuthorized(c.req.raw, clean(options.adminToken))) {
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
      ...(result.listingUnsupported ? { listingUnsupported: true, driver: result.driver } : {}),
    })
    // A driver that cannot enumerate provider state did not sweep — it
    // failed to look. Four empty arrays behind a 200 is the silent success
    // finding B1 names, so this path is loud in both channels: a warning the
    // cron surfaces, and a non-2xx the caller (including the cron's own
    // response check in worker.ts) cannot mistake for a clean sweep.
    if (result.listingUnsupported) {
      console.warn(
        `[sandbox-gc] driver "${result.driver ?? "unknown"}" cannot list provider state — `
        + "orphaned sandboxes are UNDETECTABLE from the control plane; provider-side expiry is the only reaper",
      )
      return c.json({ ...result, error: "sandbox_gc_listing_unsupported" }, 501)
    }
    // W5 (metric spec §4.2): a GC destroy ends a billable interval, one event
    // per reclaimed sandbox rather than one per sweep — the rollup counts
    // leases, so a batched event would collapse many closes into one.
    //
    // These routes authenticate an OPERATOR bearer token, not a user, so no
    // signed tenant exists at this site by construction and the events go out
    // on the ops plane. The authoritative duration is settled in Convex by the
    // lease close path; `active_ms` is omitted here rather than guessed, since
    // a zero would average into the per-user answer as real data.
    const endedAt = Date.now()
    for (const target of result.destroyed) {
      emitSandboxLeaseClosed({
        identity: undefined,
        sink: options.telemetry,
        lease: {
          workspace_id: target.workspaceId ?? "",
          ...(target.sandboxId ? { sandbox_id: target.sandboxId } : {}),
          driver: target.driver?.id ?? "unknown",
          ended_at: endedAt,
          reason: "gc",
        },
        systemReason: "internal_admin_token_has_no_user",
      })
    }
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
    // Read the lease before releasing it: `release` deletes the row, and the
    // driver is the rollup's grouping key. `list` rather than `target` because a
    // lease being released is often already stopped, which `target` reports as
    // unavailable with no driver identity at all.
    const lease = await options.sandboxManager
      .list()
      .then((leases) => leases.find((row) => row.workspaceId === workspaceId))
      .catch(() => undefined)
    const result = await options.sandboxManager.release(workspaceId)
    capture(options, "sandbox.release", {
      workspaceId,
      released: result.released,
    })
    if (result.released) {
      emitSandboxLeaseClosed({
        identity: undefined,
        sink: options.telemetry,
        lease: {
          workspace_id: workspaceId,
          ...(lease?.sandboxId ? { sandbox_id: lease.sandboxId } : {}),
          driver: lease?.driver ?? "unknown",
          ended_at: Date.now(),
          reason: "explicit_release",
        },
        systemReason: "internal_admin_token_has_no_user",
      })
    }
    return c.json(result)
  })

  return app
}

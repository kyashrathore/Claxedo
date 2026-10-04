import { Hono } from "hono"
import { errorBody } from "@claxedo/server-core/platform/http/http"
import type { ControlPlaneTelemetry } from "../../authority/services"
import type { SandboxManager, SandboxMutationResult } from "@claxedo/sandbox-manager"
import { internalAdminAuthorized } from "../../platform/http/internal-admin-auth"
import { emitSandboxLeaseClosed } from "../../platform/telemetry/product/metering"
import { readJsonRecord, stringField } from "@claxedo/server-core/platform/json/index"
import { trimToUndefined } from "@claxedo/helpers/string"

export type HostedSandboxAdminOptions = {
  adminToken?: string
  sandboxManager?: SandboxManager
  telemetry?: ControlPlaneTelemetry
  /** The secret the sandbox Worker and this plane share for the idle stop alone. */
  idleStopToken?: string
  idleStop?: (workspaceId: string, epoch: number, idleBefore: number) => Promise<SandboxMutationResult>
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

  app.post("/internal/sandbox/idle-stop", async (c) => {
    if (!internalAdminAuthorized(c.req.raw, trimToUndefined(options.idleStopToken))) {
      return c.json(errorBody("sandbox_idle_stop_unauthorized", "Idle stop requires the idle-stop bearer token"), 401)
    }
    const body = await readJsonRecord(c.req.raw)
    const workspaceId = trimToUndefined(stringField(body, "workspaceId"))
    const epoch = body?.epoch
    const idleBefore = body?.idleBefore
    if (!workspaceId || typeof epoch !== "number" || !Number.isSafeInteger(epoch) || typeof idleBefore !== "number" || !Number.isSafeInteger(idleBefore)) {
      return c.json(errorBody("sandbox_admin_invalid_request", "Idle stop requires a workspaceId, the lease epoch and idleBefore"), 400)
    }
    if (!options.idleStop) return c.json(errorBody("sandbox_unavailable", "Cloud sandbox is not configured"), 501)
    try {
      const stopped = await options.idleStop(workspaceId, epoch, idleBefore)
      return c.json(stopped, stopped.ok ? 200 : 409)
    } catch (error) {
      return c.json(errorBody("sandbox_idle_stop_refused", error instanceof Error ? error.message : String(error)), 409)
    }
  })

  app.use("/internal/sandbox-manager/*", async (c, next) => {
    if (!internalAdminAuthorized(c.req.raw, trimToUndefined(options.adminToken))) {
      return c.json(errorBody("sandbox_admin_unauthorized", "Sandbox admin routes require a matching bearer token"), 401)
    }
    await next()
    return undefined
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
      ...(result.unreachable ? { unreachable: result.unreachable.length } : {}),
      ...(result.listingUnsupported ? { listingUnsupported: true, driver: result.driver } : {}),
    })
    // Metric spec §4.2: a GC destroy ends a billable interval, one event
    // per reclaimed sandbox rather than one per sweep — the rollup counts
    // leases, so a batched event would collapse many closes into one. A sweep
    // over several provider keys destroys on the keys it could list even when
    // another could not, so these close before any refusal below.
    //
    // These routes authenticate an OPERATOR bearer token, not a user, so no
    // signed tenant exists at this site by construction and the events go out
    // on the ops plane. The authoritative duration is settled in the authority by the
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
    for (const account of result.unreachable ?? []) {
      console.warn(`[sandbox-gc] an organization's "${account.driver}" sandbox key could not be swept: ${account.error}`)
    }
    // A driver that cannot enumerate provider state did not sweep — it
    // failed to look. Four empty arrays behind a 200 is the silent success
    // the review names, so this path is loud in both channels: a warning the
    // cron surfaces, and a non-2xx the caller (including the cron's own
    // response check in worker.ts) cannot mistake for a clean sweep.
    if (result.listingUnsupported) {
      console.warn(
        `[sandbox-gc] driver "${result.driver ?? "unknown"}" cannot list provider state — `
        + "orphaned sandboxes are UNDETECTABLE from the control plane; provider-side expiry is the only reaper",
      )
      return c.json({ ...result, error: "sandbox_gc_listing_unsupported" }, 501)
    }
    return c.json(result)
  })

  app.post("/internal/sandbox-manager/release", async (c) => {
    if (!options.sandboxManager) {
      return c.json(errorBody("sandbox_unavailable", "Cloud sandbox is not configured"), 501)
    }
    const body = await readJsonRecord(c.req.raw)
    const workspaceId = trimToUndefined(stringField(body, "workspaceId"))
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

import { Hono } from "hono"
import type { WorkspaceCheckpointControl, WorkspaceCheckpointDrainPolicy } from "../workspace/host"
import type { WorkspaceWorktreeManager } from "../worktree"
import { errorBody } from "./http"
import type { RelayHostAuthContext } from "../workspace-host-service-auth"
import { authorizeHostCapability, type HostCapabilityAccessOptions } from "./host-capability-access"

export function CheckpointRoutes(input: {
  checkpoint: WorkspaceCheckpointControl
  worktrees?: WorkspaceWorktreeManager
} & HostCapabilityAccessOptions) {
  return new Hono<{ Variables: RelayHostAuthContext }>()
    .use("*", async (c, next) => {
      const write = !["GET", "HEAD", "OPTIONS"].includes(c.req.method)
      const denied = await authorizeHostCapability(c, input, write ? "checkpoint_write" : "checkpoint_read")
      return denied ?? await next()
    })
    .get("/", (c) => c.json(input.checkpoint.detail()))
    .post("/freeze", async (c) => {
      const body = await c.req.json().catch(() => ({})) as { policy?: unknown }
      const policy: WorkspaceCheckpointDrainPolicy = body.policy === "interrupt" ? "interrupt" : "drain"
      return c.json(await input.checkpoint.freeze(policy))
    })
    .post("/flush", async (c) => {
      try {
        await input.checkpoint.flush()
        await input.worktrees?.flush()
        return c.json({ ok: true })
      } catch (error) {
        return c.json(errorBody("workspace_checkpoint_flush_failed", message(error)), 409)
      }
    })
    .post("/scrub", async (c) => {
      try {
        await input.checkpoint.scrub()
        return c.json({ ok: true })
      } catch (error) {
        return c.json(errorBody("workspace_checkpoint_scrub_failed", message(error)), 409)
      }
    })
    .post("/resume", async (c) => c.json(await input.checkpoint.resume()))
    .post("/restore-reconcile", async (c) => {
      const body = await c.req.json().catch(() => null) as { epoch?: unknown; checkpointId?: unknown } | null
      if (
        !Number.isSafeInteger(body?.epoch)
        || (body?.epoch as number) < 1
        || typeof body?.checkpointId !== "string"
        || !body.checkpointId.trim()
      ) {
        return c.json(errorBody("workspace_checkpoint_reconcile_invalid", "epoch and checkpointId are required"), 400)
      }
      try {
        await input.worktrees?.reconcile()
        return c.json(await input.checkpoint.restoreReconcile({
          epoch: body.epoch as number,
          checkpointId: body.checkpointId,
        }))
      } catch (error) {
        return c.json(errorBody("workspace_checkpoint_reconcile_failed", message(error)), 409)
      }
    })
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

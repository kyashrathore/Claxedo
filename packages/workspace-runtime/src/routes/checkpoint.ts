import { Hono } from "hono"
import { num, str } from "../json-value"
import type { WorkspaceCheckpointControl, WorkspaceCheckpointDrainPolicy } from "../workspace/host"
import type { WorkspaceWorktreeManager } from "../worktree"
import { boundedJsonRecord, errorBody, isRequestBodyTooLarge, requestBodyTooLargeBody } from "./http"
import type { RelayHostAuthContext } from "../workspace-host-service-auth"
import { authorizeHostCapability, type HostCapabilityAccessOptions } from "./host-capability-access"
import { WORKSPACE_RUNTIME_MANAGEMENT_TOKEN_HEADER } from "../management-auth"
import { authorizeManagementAccess, type ManagementAccessOptions } from "./management-access"

export function CheckpointRoutes(input: {
  checkpoint: WorkspaceCheckpointControl
  worktrees?: WorkspaceWorktreeManager
} & HostCapabilityAccessOptions & ManagementAccessOptions) {
  return new Hono<{ Variables: RelayHostAuthContext }>()
    .onError((err, c) => {
      if (isRequestBodyTooLarge(err)) return c.json(requestBodyTooLargeBody(), 413)
      throw err
    })
    .use("*", async (c, next) => {
      if (c.req.header(WORKSPACE_RUNTIME_MANAGEMENT_TOKEN_HEADER) !== undefined) {
        const verdict = await authorizeManagementAccess(c, input, "runtime.checkpoint.control")
        return verdict.ok ? await next() : c.json(errorBody(verdict.code, verdict.message), verdict.status)
      }
      const write = !["GET", "HEAD", "OPTIONS"].includes(c.req.method)
      const denied = await authorizeHostCapability(c, input, write ? "checkpoint_write" : "checkpoint_read")
      return denied ?? await next()
    })
    .get("/", (c) => c.json(input.checkpoint.detail()))
    .post("/freeze", async (c) => {
      const body = await boundedJsonRecord(c)
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
      const body = await boundedJsonRecord(c)
      const epoch = num(body.epoch)
      const checkpointId = str(body.checkpointId)
      if (epoch === undefined || !Number.isSafeInteger(epoch) || epoch < 1 || !checkpointId?.trim()) {
        return c.json(errorBody("workspace_checkpoint_reconcile_invalid", "epoch and checkpointId are required"), 400)
      }
      try {
        await input.worktrees?.reconcile()
        return c.json(await input.checkpoint.restoreReconcile({ epoch, checkpointId }))
      } catch (error) {
        return c.json(errorBody("workspace_checkpoint_reconcile_failed", message(error)), 409)
      }
    })
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

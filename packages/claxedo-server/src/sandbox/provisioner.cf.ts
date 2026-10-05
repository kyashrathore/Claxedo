import { DurableObject } from "cloudflare:workers"
import { sandboxRuntimeBootFailure } from "@claxedo/sandbox-manager"
import type { SandboxStartAnswer, SandboxStartDrive } from "../workspace/sandbox-start"

type Run = { workspaceId: string; epoch: number; homeRegion: string; startedAt: number; retryAfterMs: number }
type Outcome = { epoch: number; answer: SandboxStartAnswer }

/** A start still not settled this long after it began ends with that as its reason. */
const START_WALL_MS = 15 * 60_000

/** How long the start waits before its next driver step; nothing when this answer ends it. */
function nextStepAfter(answer: SandboxStartAnswer): number | undefined {
  if (answer.status === "provisioning") return answer.retryAfterMs
  if (answer.status !== "unavailable" || answer.retryAfterMs === undefined) return undefined
  return sandboxRuntimeBootFailure(answer.error) === undefined ? answer.retryAfterMs : undefined
}

/**
 * One per workspace, named `workspace:<workspaceId>`. A Worker cuts work held
 * past a response about 30 s after it, so a cold start driven from the start
 * request died with a closed tab and left the lease `acquiring` until the
 * stale window let the next start take it over. Here `start` takes the lease
 * and answers at once; the alarm drives the driver, step by step, until the
 * lease is ready or the start has failed, and the first `start` after that
 * settles reports the outcome.
 */
export function sandboxProvisionerClass<Env>(drive: (env: Env) => SandboxStartDrive) {
  return class SandboxProvisioner extends DurableObject<Env> {
    #driving = false

    async start(workspaceId: string): Promise<SandboxStartAnswer> {
      const storage = this.ctx.storage
      const run = await storage.get<Run>("run")
      if (run) {
        if (!this.#driving && (await storage.getAlarm()) === null) await storage.setAlarm(Date.now())
        return { status: "provisioning", retryAfterMs: run.retryAfterMs, epoch: run.epoch, homeRegion: run.homeRegion }
      }
      const outcome = await storage.get<Outcome>("outcome")
      if (outcome) {
        await storage.delete("outcome")
        if (outcome.answer.status !== "ready") return outcome.answer
        const current = await drive(this.env).target(workspaceId)
        if (current.status === "ready" && current.epoch === outcome.epoch) return current
      }
      const admitted = await drive(this.env).acquire(workspaceId)
      if (admitted.status !== "provisioning") return admitted
      const begun: Run = {
        workspaceId,
        epoch: admitted.epoch,
        homeRegion: admitted.homeRegion,
        startedAt: Date.now(),
        retryAfterMs: admitted.retryAfterMs,
      }
      await storage.put("run", begun)
      await storage.setAlarm(Date.now())
      return admitted
    }

    async alarm() {
      this.#driving = true
      try {
        const storage = this.ctx.storage
        const run = await storage.get<Run>("run")
        if (!run) return
        const answer: SandboxStartAnswer = Date.now() - run.startedAt >= START_WALL_MS
          ? {
              status: "unavailable",
              error: `the sandbox did not start within ${START_WALL_MS / 60_000} minutes`,
              epoch: run.epoch,
              homeRegion: run.homeRegion,
            }
          : await drive(this.env).provision(run.workspaceId, run.epoch)
        const retryAfterMs = nextStepAfter(answer)
        if (retryAfterMs !== undefined) {
          await storage.put("run", { ...run, retryAfterMs })
          await storage.setAlarm(Date.now() + retryAfterMs)
          return
        }
        await storage.delete("run")
        const outcome: Outcome = { epoch: run.epoch, answer }
        await storage.put("outcome", outcome)
      } finally {
        this.#driving = false
      }
    }
  }
}

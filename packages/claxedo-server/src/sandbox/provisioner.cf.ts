import { DurableObject } from "cloudflare:workers"
import { sandboxLeaseEndedUnderStart, sandboxRuntimeBootFailure } from "@claxedo/sandbox-manager"
import type { SandboxStartAnswer, SandboxStartDrive } from "../workspace/sandbox-start"

/** `failure` is the error of the last step that failed and is being retried; a step that succeeds or ends the run clears it. */
type Run = { workspaceId: string; epoch: number; homeRegion: string; startedAt: number; retryAfterMs: number; failure?: string }
type Outcome = { epoch: number; answer: SandboxStartAnswer; settledAt: number }
/** A step the alarm owes a serving sandbox: when it is next due, and how many steps in a row threw before it. */
type FollowUp = { workspaceId: string; at: number; failures: number }

type ReadyAnswer = Extract<SandboxStartAnswer, { status: "ready" }>
type StartStep = Parameters<NonNullable<SandboxStartDrive["announce"]>>[1]

/**
 * The steps a ready sandbox is followed up with from the alarm, each recorded
 * under its own storage key: the field of a ready answer that first schedules
 * it, and the drive step that runs it and answers when it is due again.
 */
const FOLLOW_UPS = {
  renewal: { due: "renewAt", step: (drive: SandboxStartDrive, workspaceId: string) => drive.renew(workspaceId) },
  watch: { due: "watchAt", step: (drive: SandboxStartDrive, workspaceId: string, failures: number) => drive.watch(workspaceId, failures) },
} as const satisfies Record<string, { due: keyof ReadyAnswer; step: (drive: SandboxStartDrive, workspaceId: string, failures: number) => Promise<number | undefined> }>

type FollowUpKey = keyof typeof FOLLOW_UPS
const FOLLOW_UP_KEYS: readonly FollowUpKey[] = ["renewal", "watch"]

/** A start still not settled this long after it began ends with that as its reason. */
const START_WALL_MS = 15 * 60_000

/**
 * How long a settled outcome waits for the poller whose start began the run.
 * A poller comes back within its retryAfterMs (2 s in production, a minute
 * from a throttled background tab); an outcome older than this belongs to a
 * poller that left, and a `ready` one would soon describe a sandbox that has
 * since stopped on its own.
 */
const OUTCOME_HELD_MS = 2 * 60_000

/** A follow-up step that threw is tried again this much later, counted; one that found no serving sandbox is not tried again. */
const FOLLOW_UP_RETRY_MS = 30_000

export type SandboxProvisionerTiming = { outcomeHeldMs?: number; followUpRetryMs?: number }

/** How long the start waits before its next driver step; nothing when this answer ends it, as a spent retry budget does. */
function nextStepAfter(answer: SandboxStartAnswer): number | undefined {
  if (answer.status === "provisioning") return answer.retryAfterMs
  if (answer.status !== "unavailable" || answer.retryAfterMs === undefined || answer.exhausted) return undefined
  return sandboxRuntimeBootFailure(answer.error) === undefined ? answer.retryAfterMs : undefined
}

function settledStep(answer: SandboxStartAnswer): StartStep {
  if (answer.status === "ready") return "ready"
  return answer.status === "unavailable" && sandboxLeaseEndedUnderStart(answer.error) ? "stopped" : "error"
}

/**
 * A step that threw, as the run's answer. An exception out of the alarm would
 * leave `run` in storage, and `start` answers `provisioning` for as long as a
 * run exists: the lease can be ready in D1 while the person waits on a start
 * nothing will settle.
 */
function stepThrew(run: Run, cause: unknown): SandboxStartAnswer {
  const code = typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string" ? cause.code : undefined
  const message = cause instanceof Error ? cause.message : String(cause)
  return { status: "unavailable", error: code ? `${code}: ${message}` : message, epoch: run.epoch, homeRegion: run.homeRegion }
}

/**
 * One per workspace, named `workspace:<workspaceId>`. A Worker cuts work held
 * past a response about 30 s after it, so a cold start driven from the start
 * request died with a closed tab and left the lease `acquiring` until the
 * stale window let the next start take it over. Here a start takes the lease
 * and answers at once; the alarm drives the driver, step by step, until the
 * lease is ready or the start has failed, and the first `start` within
 * `outcomeHeldMs` of a failed settling reports that failure. A run's
 * beginning and its settling are announced to the workspace owner's open
 * clients, so a tab learns of a start another tab or a session's tool call
 * asked for.
 *
 * A `start` on a ready lease, a held ready outcome included, asks the runtime
 * itself: one that answers is reported ready with no driver step, so
 * concurrent pollers and a reconnect never begin a resume of a sandbox that
 * is serving. One that does not answer (asleep, replaced since it settled, or
 * a settle nobody collected within the window) begins the run the lease
 * needs; a ready outcome believed on the lease alone minted tokens for a
 * sandbox that had been deleted underneath it. `refresh` begins the run even
 * for a live sandbox, because its settings must be delivered again.
 *
 * The same alarm follows a ready sandbox up for as long as it keeps serving: a
 * settling that names `renewAt` is re-delivered then, through `renew`, and
 * one that names `watchAt` has its idleness read then, through `watch`, which
 * stops a sandbox whose host reads none itself. The run owns the alarm while
 * one is in flight; the follow-ups take it back when the run settles.
 */
export function sandboxProvisionerClass<Env>(drive: (env: Env) => SandboxStartDrive, timing: SandboxProvisionerTiming = {}) {
  const outcomeHeldMs = timing.outcomeHeldMs ?? OUTCOME_HELD_MS
  const followUpRetryMs = timing.followUpRetryMs ?? FOLLOW_UP_RETRY_MS
  return class SandboxProvisioner extends DurableObject<Env> {
    #driving = false

    start(workspaceId: string): Promise<SandboxStartAnswer> {
      return this.#flushed(async () => {
        const joined = await this.#inFlight()
        if (joined) return joined
        const outcome = await this.ctx.storage.get<Outcome>("outcome")
        if (outcome) {
          await this.ctx.storage.delete("outcome")
          if (Date.now() - outcome.settledAt <= outcomeHeldMs && outcome.answer.status !== "ready") return outcome.answer
        }
        const live = await drive(this.env).live(workspaceId)
        if (live) return live
        return this.#begin(workspaceId)
      })
    }

    refresh(workspaceId: string): Promise<SandboxStartAnswer> {
      return this.#flushed(async () => {
        const joined = await this.#inFlight()
        if (joined) return joined
        await this.ctx.storage.delete("outcome")
        return this.#begin(workspaceId)
      })
    }

    async inFlight(): Promise<SandboxStartAnswer | undefined> {
      return this.#inFlight()
    }

    /** What a step queued leaves with the invocation that ran it; the step's own answer or failure stands. */
    async #flushed<T>(work: () => Promise<T>): Promise<T> {
      try {
        return await work()
      } finally {
        await drive(this.env).flushTelemetry?.().catch(() => undefined)
      }
    }

    async #inFlight(): Promise<SandboxStartAnswer | undefined> {
      const storage = this.ctx.storage
      const run = await storage.get<Run>("run")
      if (!run) return undefined
      if (!this.#driving && (await storage.getAlarm()) === null) await storage.setAlarm(Date.now())
      return { status: "provisioning", retryAfterMs: run.retryAfterMs, epoch: run.epoch, homeRegion: run.homeRegion, joined: true, ...(run.failure ? { failure: run.failure } : {}) }
    }

    async #begin(workspaceId: string): Promise<SandboxStartAnswer> {
      const admitted = await drive(this.env).acquire(workspaceId)
      if (admitted.status !== "provisioning") {
        await this.#settled(workspaceId, admitted)
        return admitted
      }
      const begun: Run = {
        workspaceId,
        epoch: admitted.epoch,
        homeRegion: admitted.homeRegion,
        startedAt: Date.now(),
        retryAfterMs: admitted.retryAfterMs,
      }
      await this.ctx.storage.put("run", begun)
      await this.ctx.storage.setAlarm(Date.now())
      this.#announce(workspaceId, "starting")
      return admitted
    }

    /**
     * Sent beside the answer rather than before it, so the start's own answer
     * never waits on the owner lookup and the room. A notice that fails costs
     * the clients a live update until their next read, never the start.
     */
    #announce(workspaceId: string, step: StartStep) {
      const steps = drive(this.env)
      if (!steps.announce) return
      this.ctx.waitUntil(steps.announce(workspaceId, step).catch((cause: unknown) => {
        console.warn("[sandbox-provisioner] the start notice was not delivered", { workspaceId, step, error: cause instanceof Error ? cause.message : String(cause) })
      }))
    }

    /** A ready answer's follow-ups replace the ones on record; the alarm is theirs again now that no run holds it. */
    async #settled(workspaceId: string, answer: SandboxStartAnswer) {
      const storage = this.ctx.storage
      this.#announce(workspaceId, settledStep(answer))
      if (answer.status === "ready") {
        for (const key of FOLLOW_UP_KEYS) {
          const at = answer[FOLLOW_UPS[key].due]
          if (at === undefined) await storage.delete(key)
          else await storage.put(key, { workspaceId, at, failures: 0 } satisfies FollowUp)
        }
      }
      await this.#armFollowUps()
    }

    async #armFollowUps() {
      const storage = this.ctx.storage
      const due = (await Promise.all(FOLLOW_UP_KEYS.map((key) => storage.get<FollowUp>(key)))).flatMap((record) => (record ? [record.at] : []))
      if (due.length) await storage.setAlarm(Math.max(Date.now(), Math.min(...due)))
    }

    async #followUp() {
      const storage = this.ctx.storage
      for (const key of FOLLOW_UP_KEYS) {
        const record = await storage.get<FollowUp>(key)
        if (!record || record.at > Date.now()) continue
        const next = await FOLLOW_UPS[key].step(drive(this.env), record.workspaceId, record.failures)
          .then((at) => (at === undefined ? undefined : { at, failures: 0 }), () => ({ at: Date.now() + followUpRetryMs, failures: record.failures + 1 }))
        if (next === undefined) await storage.delete(key)
        else await storage.put(key, { workspaceId: record.workspaceId, ...next } satisfies FollowUp)
      }
      await this.#armFollowUps()
    }

    alarm() {
      return this.#flushed(() => this.#step())
    }

    async #step() {
      this.#driving = true
      try {
        const storage = this.ctx.storage
        const run = await storage.get<Run>("run")
        if (!run) return this.#followUp()
        const answer: SandboxStartAnswer = Date.now() - run.startedAt >= START_WALL_MS
          ? {
              status: "unavailable",
              error: `the sandbox did not start within ${START_WALL_MS / 60_000} minutes`,
              epoch: run.epoch,
              homeRegion: run.homeRegion,
            }
          : await drive(this.env).provision(run.workspaceId, run.epoch).catch((cause: unknown) => stepThrew(run, cause))
        const retryAfterMs = nextStepAfter(answer)
        if (retryAfterMs !== undefined) {
          // A failed step's retry runs on the fresh epoch its answer names.
          const epoch = "epoch" in answer && answer.epoch !== undefined ? answer.epoch : run.epoch
          const failure = answer.status === "unavailable" ? answer.error : undefined
          const continuing: Run = { workspaceId: run.workspaceId, homeRegion: run.homeRegion, startedAt: run.startedAt, epoch, retryAfterMs, ...(failure ? { failure } : {}) }
          await storage.put("run", continuing)
          await storage.setAlarm(Date.now() + retryAfterMs)
          return
        }
        await storage.delete("run")
        // A lease stopped, destroyed or replaced under the run was somebody's
        // decision, not the start's failure: the next start reads the lease
        // and begins what it needs, instead of being told this run's end. A
        // spent budget is the lease's own answer to every start until its
        // cooldown ends or a key change lifts it, so holding it would outlive
        // the lift and freeze the time left.
        if (answer.status !== "unavailable" || !(sandboxLeaseEndedUnderStart(answer.error) || answer.exhausted)) {
          const outcome: Outcome = { epoch: run.epoch, answer, settledAt: Date.now() }
          await storage.put("outcome", outcome)
        }
        await this.#settled(run.workspaceId, answer)
      } finally {
        this.#driving = false
      }
    }
  }
}

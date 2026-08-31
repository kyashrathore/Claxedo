import type { RawHarnessEvent, RuntimeGoalSnapshot } from "@claxedo/agent-event-runtime"
import { codexStartedSubagent } from "@claxedo/agent-event-runtime/harnesses/codex"
import type { AgentGoalMutationResult, AgentGoalResource } from "../../adapter-contract"
import { GOAL_ACTIONS, goalCapabilities } from "../../capabilities"
import { Log } from "../../log"
import { requireWorkspaceDirectory } from "../../target"
import {
  errorMessage,
  record,
  text,
  type JsonRecord,
  type SdkRuntimeDriverHost,
  type SdkRuntimeTurnInput,
} from "../shared/sdk-runtime-adapter"
import type { CodexAppServerProcess } from "./app-server-process"
import {
  GoalTurnEventQueue,
  type CodexActiveThread,
  codexGoalSnapshot,
  startTurnWithThreadRecovery,
} from "./protocol"

const CODEX_SOURCE = "codex.app-server"
const log = Log.create({ service: "codex-goal-controller" })

/** The narrow slice of the Codex driver the Goal controller runs against. */
export type CodexGoalControllerHost = {
  driverHost: SdkRuntimeDriverHost
  ensureProcess(directory: string): Promise<CodexAppServerProcess>
  /**
   * The app-server only if one is already running. Session deletion cleans the
   * provider Goal up opportunistically and must never spawn a process for it.
   */
  liveProcess(): CodexAppServerProcess | null
  /** Holds the app-server resident while a Goal is active. */
  lease(): { release(): void }
  /** Shared with the driver: a thread with a live prompt turn owns its frames. */
  activeThreads: Map<string, CodexActiveThread>
  projectThreadNotification(
    input: SdkRuntimeTurnInput,
    threadId: string,
    method: string,
    params: JsonRecord,
    frame: unknown,
  ): Promise<unknown>
}

/**
 * Owns the Codex Goal surface: the AgentGoalResource mutations against the
 * app-server's `thread/goal/*` methods, the provider-notification projection
 * that turns autonomous Goal turns into runtime turns, and the idle leases
 * that keep the app-server resident while a Goal is active.
 */
export class CodexGoalController {
  readonly resource: AgentGoalResource = {
    readCapabilities: () => goalCapabilities({
      implemented: true,
      available: true,
      actions: [...GOAL_ACTIONS],
      recovery: "reconcile",
      optionalFields: ["tokenBudget", "tokensUsed", "timeUsedSeconds"],
    }),
    read: (sessionId, directory) => this.read(sessionId, requireWorkspaceDirectory(directory)),
    start: (sessionId, input, directory) => this.set(sessionId, requireWorkspaceDirectory(directory), { objective: input.objective }),
    pause: (sessionId, directory) => this.pause(sessionId, requireWorkspaceDirectory(directory)),
    resume: (sessionId, directory) => this.set(sessionId, requireWorkspaceDirectory(directory), { status: "active" }),
    stop: (sessionId, directory) => this.pause(sessionId, requireWorkspaceDirectory(directory)),
    delete: (sessionId, directory) => this.clear(sessionId, requireWorkspaceDirectory(directory)),
  }

  private leases = new Map<string, { release(): void }>()
  private bindings = new Map<string, { sessionId: string; directory: string }>()
  private statusByThread = new Map<string, RuntimeGoalSnapshot["status"]>()
  private turnQueues = new Map<string, { turnId: string; queue: GoalTurnEventQueue }>()
  private childOwners = new Map<string, string>()

  constructor(private readonly host: CodexGoalControllerHost) {}

  private threadId(sessionId: string, directory: string) {
    const threadId = this.host.driverHost.getAgentSessionId(sessionId)
    if (!threadId) throw new Error(`Session ${sessionId} has no Codex thread`)
    this.bindings.set(threadId, { sessionId, directory })
    return threadId
  }

  private reconcileLease(sessionId: string, goal: RuntimeGoalSnapshot | null) {
    if (goal?.status === "active") {
      if (!this.leases.has(sessionId)) this.leases.set(sessionId, this.host.lease())
      return
    }
    this.leases.get(sessionId)?.release()
    this.leases.delete(sessionId)
  }

  private async read(sessionId: string, directory: string) {
    const threadId = this.threadId(sessionId, directory)
    const proc = await this.host.ensureProcess(directory)
    const result = await this.requestWithThreadRecovery(proc, threadId, directory, "thread/goal/get", { threadId })
    const rawGoal = result.goal
    const goal = rawGoal ? codexGoalSnapshot(sessionId, rawGoal) : null
    if (goal) this.statusByThread.set(threadId, goal.status)
    else this.statusByThread.delete(threadId)
    this.reconcileLease(sessionId, goal)
    return goal
  }

  private requestWithThreadRecovery(
    proc: CodexAppServerProcess,
    threadId: string,
    directory: string,
    method: string,
    params: JsonRecord,
  ) {
    return startTurnWithThreadRecovery({
      startTurn: async () => {
        const response = record(await proc.request(method, params))
        if (!response) throw new Error(`Codex app-server did not return a ${method} response`)
        return response
      },
      resumeThread: async () => {
        await proc.request("thread/resume", { threadId, cwd: directory })
      },
    })
  }

  private async set(
    sessionId: string,
    directory: string,
    update: { objective?: string; status?: "active" | "paused" },
  ): Promise<AgentGoalMutationResult<RuntimeGoalSnapshot>> {
    try {
      const threadId = this.threadId(sessionId, directory)
      const proc = await this.host.ensureProcess(directory)
      const result = await this.requestWithThreadRecovery(
        proc,
        threadId,
        directory,
        "thread/goal/set",
        { threadId, ...update },
      )
      const goal = codexGoalSnapshot(sessionId, result?.goal)
      this.statusByThread.set(threadId, goal.status)
      this.reconcileLease(sessionId, goal)
      return { ok: true, goal }
    } catch (error) {
      return { ok: false, status: "failed", message: errorMessage(error) }
    }
  }

  /** Disable continuation first, then interrupt in-flight work (R:pause-order). */
  private async pause(
    sessionId: string,
    directory: string,
  ): Promise<AgentGoalMutationResult<RuntimeGoalSnapshot>> {
    const result = await this.set(sessionId, directory, { status: "paused" })
    if (!result.ok) return result
    await this.interruptTurn(sessionId)
    return result
  }

  private async clear(
    sessionId: string,
    directory: string,
  ): Promise<AgentGoalMutationResult<null>> {
    try {
      const threadId = this.threadId(sessionId, directory)
      const proc = await this.host.ensureProcess(directory)
      const result = await this.requestWithThreadRecovery(
        proc,
        threadId,
        directory,
        "thread/goal/clear",
        { threadId },
      )
      if (result?.cleared !== true) return { ok: false, status: "not_found", message: "No Codex Goal exists" }
      this.statusByThread.delete(threadId)
      this.reconcileLease(sessionId, null)
      await this.interruptTurn(sessionId)
      return { ok: true, goal: null }
    } catch (error) {
      return { ok: false, status: "failed", message: errorMessage(error) }
    }
  }

  /**
   * Best-effort provider cleanup for a session the runtime is deleting.
   *
   * Deleting local state must always succeed: it neither spawns an app-server
   * (a broken or missing Codex binary would otherwise make sessions
   * undeletable) nor propagates a provider failure. The provider Goal is only
   * cleared when a process is already running to clear it on.
   */
  async clearOnSessionDelete(sessionId: string, agentSessionId: string, directory: string) {
    const proc = this.host.liveProcess()
    if (proc?.alive) {
      try {
        await this.requestWithThreadRecovery(proc, agentSessionId, directory, "thread/goal/clear", {
          threadId: agentSessionId,
        })
      } catch (error) {
        log.warn("codex goal cleanup failed while deleting session; deleting local state anyway", {
          sessionId,
          threadId: agentSessionId,
          error: errorMessage(error),
        })
      }
    }
    this.releaseSession(sessionId, agentSessionId)
  }

  private async interruptTurn(sessionId: string) {
    const interrupted = this.host.driverHost.lifecycle().abort(sessionId)
    if (interrupted) await this.host.driverHost.lifecycle().whenIdle(sessionId)
  }

  /** Session-scoped cleanup when the driver deletes an agent session. */
  private releaseSession(sessionId: string, agentSessionId: string) {
    this.bindings.delete(agentSessionId)
    this.statusByThread.delete(agentSessionId)
    this.leases.get(sessionId)?.release()
    this.leases.delete(sessionId)
    this.turnQueues.get(agentSessionId)?.queue.end()
    this.releaseGoalTurn(agentSessionId)
  }

  /** Drops a Goal turn and the child ownership that only routed into it. */
  private releaseGoalTurn(threadId: string) {
    this.turnQueues.delete(threadId)
    for (const [childId, ownerId] of this.childOwners) {
      if (ownerId === threadId) this.childOwners.delete(childId)
    }
  }

  /**
   * Goal routing must survive a driver restart. `bindings` is armed by
   * `goals.*` calls only, so a provider notification for a thread this driver
   * is already running (an interactive turn resumed it after restart) would
   * otherwise be dropped even though the capability advertises
   * recovery: "reconcile". Recover the session from the live thread and re-arm
   * the binding so every later frame routes without the lookup.
   */
  private resolveBinding(threadId: string) {
    const known = this.bindings.get(threadId)
    if (known) return known
    const active = this.host.activeThreads.get(threadId)
    if (!active) return
    const binding = { sessionId: active.sessionId, directory: active.directory }
    this.bindings.set(threadId, binding)
    return binding
  }

  private handleGoalNotification(method: string, params: JsonRecord) {
    const threadId = text(params.threadId) ?? text(record(params.goal)?.threadId)
    if (!threadId) return
    const binding = this.resolveBinding(threadId)
    if (!binding) return
    const goal = method === "thread/goal/cleared"
      ? null
      : codexGoalSnapshot(binding.sessionId, params.goal)
    if (goal) this.statusByThread.set(threadId, goal.status)
    else this.statusByThread.delete(threadId)
    this.reconcileLease(binding.sessionId, goal)
    this.host.driverHost.publishGoal({ ...binding, goal })
  }

  handleProcessMessage(message: JsonRecord) {
    const method = text(message.method)
    if (!method) return
    const params = record(message.params) ?? {}
    if (method === "thread/goal/updated" || method === "thread/goal/cleared") {
      this.handleGoalNotification(method, params)
      return
    }
    const directThreadId = text(params.threadId) ?? text(record(params.thread)?.id)
    if (!directThreadId) return
    const startedSubagent = method === "thread/started" ? codexStartedSubagent(params) : undefined
    // A child only needs an owner while that owner has a Goal turn to route
    // its frames into; recording every parented thread grew the map for the
    // driver's whole life.
    if (startedSubagent?.parentThreadId && this.turnQueues.has(startedSubagent.parentThreadId)) {
      this.childOwners.set(startedSubagent.id, startedSubagent.parentThreadId)
    }
    const threadId = this.childOwners.get(directThreadId) ?? directThreadId
    if (this.host.activeThreads.has(threadId) && !this.turnQueues.has(threadId)) return
    const binding = this.resolveBinding(threadId)
    if (!binding) return
    const raw: RawHarnessEvent = { source: CODEX_SOURCE, method, payload: params }
    if (method === "turn/started" && directThreadId === threadId && !this.turnQueues.has(threadId)) {
      // Only an ACTIVE Goal admits a new provider turn. A paused Goal must not
      // start projecting new work, but a turn that was already admitted keeps
      // receiving its frames below so `turn/completed` can end its queue —
      // otherwise pausing mid-turn strands the runtime turn busy forever.
      if (this.statusByThread.get(threadId) !== "active") return
      const turnId = text(record(params.turn)?.id)
      if (!turnId) return
      const queue = new GoalTurnEventQueue()
      this.turnQueues.set(threadId, { turnId, queue })
      void this.host.driverHost.runProviderTurn(binding, async (input) => {
        const proc = await this.host.ensureProcess(binding.directory)
        const project = (eventMethod: string, payload: JsonRecord, frame: unknown) => input.ingest({
          source: CODEX_SOURCE,
          method: eventMethod,
          payload,
        }, {
          dir: "in",
          method: eventMethod,
          frame,
        })
        this.host.activeThreads.set(threadId, {
          ...binding,
          agentSessionId: threadId,
          process: proc,
          project,
          observeSubagent: input.observeSubagent,
        })
        const onAbort = () => queue.end()
        input.abort.signal.addEventListener("abort", onAbort, { once: true })
        try {
          for await (const event of queue) {
            const eventMethod = event.method ?? "codex.goal-turn"
            await this.host.projectThreadNotification(
              input,
              threadId,
              eventMethod,
              record(event.payload) ?? {},
              event,
            )
          }
        } finally {
          input.abort.signal.removeEventListener("abort", onAbort)
          this.host.activeThreads.delete(threadId)
          this.releaseGoalTurn(threadId)
        }
      }).then((admitted) => {
        if (admitted || this.turnQueues.get(threadId)?.queue !== queue) return
        queue.end()
        this.releaseGoalTurn(threadId)
      })
      queue.push(raw)
      return
    }
    const active = this.turnQueues.get(threadId)
    if (!active) return
    active.queue.push(raw)
    // Only the Goal thread's OWN turn ends the Goal turn. A child agent
    // completing routes through its owner, and ending the queue on it would
    // drop every remaining parent frame — the same guard the interactive turn
    // applies through `parentOwned`.
    if (method === "turn/completed" && directThreadId === threadId) active.queue.end()
  }

  dispose() {
    for (const lease of this.leases.values()) lease.release()
    this.leases.clear()
    this.bindings.clear()
    this.statusByThread.clear()
    for (const turn of this.turnQueues.values()) turn.queue.end()
    this.turnQueues.clear()
    this.childOwners.clear()
  }
}

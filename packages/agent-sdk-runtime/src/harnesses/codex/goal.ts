import type { RawHarnessEvent, RuntimeGoalSnapshot } from "@claxedo/agent-event-runtime"
import { randomUUID } from "crypto"
import type { AgentGoalMutationResult, AgentGoalResource } from "../../adapter-contract"
import { GOAL_ACTIONS, goalCapabilities } from "../../capabilities"
import { Log } from "../../log"
import { requireWorkspaceDirectory } from "../../target"
import { settleGoalStop } from "../shared/goal-stop-order"
import { createTurnStopRecord } from "../shared/cancellation-facts"
import { asRecord } from "@claxedo/helpers/guards"
import { controlRequestDeadline, goalStopDeadline } from "../shared/request-deadline"
import {
  errorMessage,
  text,
  type JsonRecord,
  type SdkRuntimeDriverHost,
  type SdkRuntimeTurnInput,
} from "../shared/sdk-runtime-adapter"
import type { CodexAppServerProcess } from "./app-server-process"
import {
  GoalTurnEventQueue,
  createCodexTurnStop,
  codexGoalSnapshot,
  startTurnWithThreadRecovery,
} from "./protocol"
import { codexNotificationThreadId, type CodexThreadRegistry, type CodexTurnClaim } from "./thread-registry"

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
  /**
   * The `thread/resume` override that re-attaches the session's first-party MCP
   * entry. A Goal turn resumes the same thread the driver started, and the
   * app-server drops a thread's MCP clients when it reloads it, so a resume
   * that omits this leaves the Goal running without Claxedo's own tools.
   */
  threadConfig(sessionId: string): { config?: JsonRecord }
  /** The driver's record of which running turn owns each thread; a Goal turn claims its thread there. */
  threads: CodexThreadRegistry
  /** One provider turn's notification projector. */
  threadProjection(
    input: SdkRuntimeTurnInput,
    claim: CodexTurnClaim,
  ): { project(method: string, params: JsonRecord, frame: unknown): Promise<unknown> }
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
  private turnQueues = new Map<string, { turnId: string; queue: GoalTurnEventQueue; claim: CodexTurnClaim }>()
  private pendingGoalRequests = new Map<string, { id: string; text: string }>()

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
    const result = await this.requestWithThreadRecovery(proc, sessionId, threadId, directory, "thread/goal/get", { threadId })
    const rawGoal = result.goal
    const goal = rawGoal ? codexGoalSnapshot(sessionId, rawGoal) : null
    if (goal) this.statusByThread.set(threadId, goal.status)
    else this.statusByThread.delete(threadId)
    this.reconcileLease(sessionId, goal)
    return goal
  }

  private requestWithThreadRecovery(
    proc: CodexAppServerProcess,
    sessionId: string,
    threadId: string,
    directory: string,
    method: string,
    params: JsonRecord,
  ) {
    return startTurnWithThreadRecovery({
      startTurn: async () => {
        const response = asRecord(await proc.request(method, params, controlRequestDeadline()))
        if (!response) throw new Error(`Codex app-server did not return a ${method} response`)
        return response
      },
      resumeThread: async () => {
        const resumed = asRecord(await proc.request("thread/resume", {
          threadId,
          cwd: directory,
          ...this.host.threadConfig(sessionId),
        }, controlRequestDeadline()))
        this.host.threads.recordModel(threadId, resumed?.model)
      },
    })
  }

  private async set(
    sessionId: string,
    directory: string,
    update: { objective?: string; status?: "active" | "paused" },
  ): Promise<AgentGoalMutationResult<RuntimeGoalSnapshot>> {
    let requestedThread: string | undefined
    const userMessage = update.objective === undefined ? undefined : { id: randomUUID(), text: update.objective }
    try {
      const threadId = this.threadId(sessionId, directory)
      requestedThread = threadId
      if (userMessage) this.pendingGoalRequests.set(threadId, userMessage)
      const proc = await this.host.ensureProcess(directory)
      const result = await this.requestWithThreadRecovery(
        proc,
        sessionId,
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
      if (requestedThread && this.pendingGoalRequests.get(requestedThread) === userMessage) this.pendingGoalRequests.delete(requestedThread)
      return { ok: false, status: "failed", message: errorMessage(error) }
    }
  }

  /** Disable continuation first, then interrupt in-flight work (R:pause-order). */
  private pause(
    sessionId: string,
    directory: string,
  ): Promise<AgentGoalMutationResult<RuntimeGoalSnapshot>> {
    return settleGoalStop({
      sessionId,
      deadline: goalStopDeadline(),
      lifecycle: this.host.driverHost.lifecycle(),
      disableContinuation: () => this.set(sessionId, directory, { status: "paused" }),
    })
  }

  private clear(
    sessionId: string,
    directory: string,
  ): Promise<AgentGoalMutationResult<null>> {
    return settleGoalStop<null>({
      sessionId,
      deadline: goalStopDeadline(),
      lifecycle: this.host.driverHost.lifecycle(),
      disableContinuation: async () => {
        try {
          const threadId = this.threadId(sessionId, directory)
          const proc = await this.host.ensureProcess(directory)
          const result = await this.requestWithThreadRecovery(
            proc,
            sessionId,
            threadId,
            directory,
            "thread/goal/clear",
            { threadId },
          )
          if (result?.cleared !== true) return { ok: false, status: "not_found", message: "No Codex Goal exists" }
          this.statusByThread.delete(threadId)
          this.reconcileLease(sessionId, null)
          return { ok: true, goal: null }
        } catch (error) {
          return { ok: false, status: "failed", message: errorMessage(error) }
        }
      },
    })
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
        await this.requestWithThreadRecovery(proc, sessionId, agentSessionId, directory, "thread/goal/clear", {
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

  /** Session-scoped cleanup when the driver deletes an agent session. */
  private releaseSession(sessionId: string, agentSessionId: string) {
    this.pendingGoalRequests.delete(agentSessionId)
    this.bindings.delete(agentSessionId)
    this.statusByThread.delete(agentSessionId)
    this.leases.get(sessionId)?.release()
    this.leases.delete(sessionId)
    this.turnQueues.get(agentSessionId)?.queue.end()
    this.releaseGoalTurn(agentSessionId)
  }

  /** Drops a Goal turn and its claim on the thread. */
  private releaseGoalTurn(threadId: string) {
    this.turnQueues.get(threadId)?.claim.end()
    this.turnQueues.delete(threadId)
  }

  /**
   * Goal routing must survive a driver restart. `bindings` is armed by
   * `goals.*` calls only, so a provider notification for a thread this driver
   * is already running would otherwise be dropped even though the capability
   * advertises recovery: "reconcile".
   *
   * A live thread names its own session. An ACTIVE Goal outlives its turns
   * though — the autonomous `turn/started` that opens the next iteration
   * arrives with no turn at all — so the runtime's own session index answers
   * for every session it has bound or prompted. Either way the binding is
   * re-armed, so later frames route without the lookup.
   */
  private resolveBinding(threadId: string) {
    const known = this.bindings.get(threadId)
    if (known) return known
    const active = this.host.threads.activeThreads.get(threadId)
    const binding = active
      ? { sessionId: active.sessionId, directory: active.directory }
      : this.host.driverHost.getSessionForAgentSession(threadId)
    if (!binding) return undefined
    this.bindings.set(threadId, binding)
    return binding
  }

  private handleGoalNotification(method: string, params: JsonRecord) {
    const threadId = text(params.threadId) ?? text(asRecord(params.goal)?.threadId)
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
    const params = asRecord(message.params) ?? {}
    if (method === "thread/goal/updated" || method === "thread/goal/cleared") {
      this.handleGoalNotification(method, params)
      return
    }
    const directThreadId = codexNotificationThreadId(params)
    if (!directThreadId) return
    const raw: RawHarnessEvent = { source: CODEX_SOURCE, method, payload: params }
    const owner = this.host.threads.ownerOf(directThreadId)
    if (owner) {
      const active = owner.kind === "goal" ? this.turnQueues.get(owner.threadId) : undefined
      if (active?.claim !== owner) return
      active.queue.push(raw)
      // Only the Goal thread's OWN turn ends the Goal turn. A child agent
      // completing routes through its owner, and ending the queue on it would
      // drop every remaining parent frame — the same guard the interactive turn
      // applies through `parentOwned`. The claim ends with it, so the next
      // iteration's `turn/started` opens a turn of its own while this one
      // drains what it already holds.
      if (method === "turn/completed" && directThreadId === owner.threadId) {
        active.queue.end()
        owner.end()
      }
      return
    }
    if (method !== "turn/started") return
    const threadId = directThreadId
    const binding = this.resolveBinding(threadId)
    if (!binding) return
    // Only an ACTIVE Goal admits a new provider turn. A paused Goal must not
    // start projecting new work, but a turn that was already admitted keeps
    // receiving its frames above so `turn/completed` can end its queue —
    // otherwise pausing mid-turn strands the runtime turn busy forever.
    if (this.statusByThread.get(threadId) !== "active") return
    const turnId = text(asRecord(params.turn)?.id)
    if (!turnId) return
    const queue = new GoalTurnEventQueue()
    const claim = this.host.threads.beginTurn(threadId, "goal")
    this.turnQueues.set(threadId, { turnId, queue, claim })
    const userMessage = this.pendingGoalRequests.get(threadId)
    void this.host.driverHost.runProviderTurn({ ...binding, ...(userMessage ? { userMessage } : {}) }, async (input) => {
      if (this.pendingGoalRequests.get(threadId) === userMessage) this.pendingGoalRequests.delete(threadId)
      const proc = await this.host.ensureProcess(binding.directory)
      const stops = createTurnStopRecord()
      const cancellation = createCodexTurnStop({ process: proc, threadId, record: stops, turnId: () => turnId, subagentThreads: () => claim.subagentThreads() })
      const projection = this.host.threadProjection(input, claim)
      const project = (eventMethod: string, payload: JsonRecord, frame: unknown) => input.ingest({
        source: CODEX_SOURCE,
        method: eventMethod,
        payload,
      }, {
        dir: "in",
        method: eventMethod,
        frame,
      })
      claim.attach({
        ...binding,
        agentSessionId: threadId,
        process: proc,
        project,
        observeSubagent: input.observeSubagent,
        adoptSubagent: (childThreadId) => this.host.threads.adopt(childThreadId, threadId),
      }, input.input.assistantMessageId)
      const onAbort = () => {
        // Recorded on `stops` rather than awaited; the Goal turn ends now.
        void cancellation.stop()
        queue.end()
      }
      input.abort.signal.addEventListener("abort", onAbort, { once: true })
      this.host.driverHost.lifecycle().set(binding.sessionId, { abort: input.abort, close: cancellation.stop, stops, turnId })
      try {
        for await (const event of queue) {
          const eventMethod = event.method ?? "codex.goal-turn"
          cancellation.observe(eventMethod, asRecord(event.payload) ?? {})
          await projection.project(eventMethod, asRecord(event.payload) ?? {}, event)
        }
      } finally {
        try {
          if (input.abort.signal.aborted) await cancellation.stop()
        } finally {
          input.abort.signal.removeEventListener("abort", onAbort)
          if (this.turnQueues.get(threadId)?.queue === queue) this.releaseGoalTurn(threadId)
          else claim.end()
        }
      }
    }).then((admitted) => {
      if (admitted || this.turnQueues.get(threadId)?.queue !== queue) return
      queue.end()
      this.releaseGoalTurn(threadId)
    })
    queue.push(raw)
  }

  dispose() {
    for (const lease of this.leases.values()) lease.release()
    this.leases.clear()
    this.bindings.clear()
    this.statusByThread.clear()
    for (const turn of this.turnQueues.values()) {
      turn.queue.end()
      turn.claim.end()
    }
    this.turnQueues.clear()
    this.pendingGoalRequests.clear()
  }
}

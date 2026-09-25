import path from "node:path"
import { query, type McpServerConfig, type Query, type SDKActiveGoalMessage, type SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type { AgentGoalMutationResult } from "@claxedo/agent-runtime-contract"
import type { HarnessServices, HarnessSession, RoutedEvent, SessionBroker, StartInput, TurnBroker } from "../../contract"
import { claudePlugins, composeClaudeConfigHome } from "../../profiles/claude-code"
import { claudeBinding, claudeEnvironment } from "./credentials"
import { activeGoal, goalSessionStore } from "./goal-state"
import { permissionOptions } from "./permissions"
import { ClaudeProcess } from "./process"
import { askClaudePermission } from "./requests"
import { claudeTranslator, translateClaude } from "./translate"

type Running = { turnId: string; abort: AbortController; settled: Promise<unknown> }
const protocolGoalMap = { deny: "deny" } as const

export class ClaudeGoals {
  private readonly running = new Map<string, Running>()

  constructor(private readonly services: HarnessServices, private readonly options: {
    executable: string; configRoot: string; userConfigRoot: string; env?: NodeJS.ProcessEnv
  }, private readonly mcp: (input: StartInput) => Record<string, McpServerConfig>) {}

  async start(session: HarnessSession, input: StartInput, broker: SessionBroker, objective: string): Promise<AgentGoalMutationResult> {
    if (this.running.has(input.sessionId)) return { ok: false, status: "conflict", message: "Claude Goal is running" }
    const abort = new AbortController()
    const admitted = await broker.admitProviderTurn({ reason: "goal" }, (turnBroker) => this.run(session, input, broker, turnBroker, `/goal ${objective}`, abort))
    if (!admitted.admitted) return { ok: false, status: "conflict", message: `Claude Goal admission ${admitted.reason}` }
    const running = { turnId: admitted.turnId, abort, settled: admitted.settled }
    this.running.set(input.sessionId, running)
    void admitted.settled.then(async (outcome) => {
      if (this.running.get(input.sessionId) === running) this.running.delete(input.sessionId)
      const goal = broker.goal.read()
      if (goal?.status === "active" && outcome.state !== "completed") await broker.goal.publish({ ...goal,
        status: outcome.state === "cancelled" ? "paused" : "blocked", updatedAt: Date.now(),
        ...(outcome.state === "failed" ? { lastReason: outcome.error } : {}) })
    })
    return { ok: true, goal: broker.goal.read() }
  }

  async stop(session: HarnessSession, input: StartInput, broker: SessionBroker): Promise<AgentGoalMutationResult> {
    const running = this.running.get(input.sessionId)
    if (running) { running.abort.abort(); await running.settled }
    const goal = broker.goal.read()
    if (!goal) return { ok: false, status: "not_found", message: "Claude Goal is absent" }
    if (session.binding.upstreamSessionId.startsWith("claude-sdk:")) return { ok: false, status: "failed", message: "Claude Goal has no native session to clear" }
    const abort = new AbortController()
    const timeout = setTimeout(() => abort.abort(), 30_000)
    try {
      let confirmed = false
      for await (const _event of this.run(session, input, broker, undefined, "/goal clear", abort, true, () => { confirmed = true })) {}
      if (!confirmed) throw new Error("Claude did not confirm clearing the native Goal")
      const paused = { ...goal, status: "paused" as const, updatedAt: Date.now() }
      await broker.goal.publish(paused)
      return { ok: true, goal: paused }
    } catch (error) {
      const blocked = { ...goal, status: "blocked" as const, updatedAt: Date.now(), lastReason: error instanceof Error ? error.message : String(error) }
      await broker.goal.publish(blocked)
      return { ok: false, status: "failed", message: blocked.lastReason }
    } finally { clearTimeout(timeout) }
  }

  async cancel(sessionId: string): Promise<void> {
    const running = this.running.get(sessionId)
    if (running) { running.abort.abort(); await running.settled }
  }

  turnId(sessionId: string): string | undefined { return this.running.get(sessionId)?.turnId }

  private async launch(session: HarnessSession, input: StartInput, broker: SessionBroker, turnBroker: TurnBroker | undefined,
    prompt: string, abort: AbortController, clear: boolean): Promise<{ stream: Query; processes: ClaudeProcess[] }> {
    const binding = claudeBinding(input.credentials, input.owner)
    const home = binding ? await composeClaudeConfigHome(path.join(this.options.configRoot, input.sessionId), this.options.userConfigRoot) : undefined
    const processes: ClaudeProcess[] = []
    const stream = query({ prompt, options: {
      cwd: input.directory, pathToClaudeCodeExecutable: this.options.executable,
      env: claudeEnvironment(this.options.env ?? process.env, binding, home), abortController: abort,
      ...(session.binding.upstreamSessionId.startsWith("claude-sdk:") ? {} : { resume: session.binding.upstreamSessionId }),
      ...(clear ? { tools: [], maxTurns: 1 } : { ...permissionOptions(input.config), plugins: claudePlugins(input.projection),
        mcpServers: this.mcp(input), forwardSubagentText: true, settingSources: ["user", "project", "local"] as const,
        sessionStore: goalSessionStore(broker, abort.signal), sessionStoreFlush: "eager" as const }),
      canUseTool: (name, payload, options) => clear || !turnBroker
        ? Promise.resolve({ behavior: protocolGoalMap.deny, message: "Clearing the native Goal cannot run tools" })
        : askClaudePermission(input, turnBroker, name, payload, options),
      spawnClaudeCodeProcess: (options) => {
        const child = new ClaudeProcess(this.services, options, input.sessionId)
        processes.push(child)
        return child
      },
    } })
    return { stream, processes }
  }

  private async *run(session: HarnessSession, input: StartInput, broker: SessionBroker, turnBroker: TurnBroker | undefined,
    prompt: string, abort: AbortController, clear = false, confirm?: () => void): AsyncIterable<RoutedEvent> {
    const { stream, processes } = await this.launch(session, input, broker, turnBroker, prompt, abort, clear)
    const { runtime, tasks } = claudeTranslator(session.binding.sessionId)
    try {
      for await (const message of stream as AsyncIterable<SDKMessage | SDKActiveGoalMessage>) {
        if (message.type === "active_goal") { if (!abort.signal.aborted) await broker.goal.publish(activeGoal(input.sessionId, message)); continue }
        if ("session_id" in message && typeof message.session_id === "string" && message.session_id &&
          session.binding.upstreamSessionId !== message.session_id) {
          session.binding.upstreamSessionId = message.session_id
          await broker.rebind(message.session_id)
        }
        if (clear) {
          if (message.type === "result" && message.subtype === "success" && !message.is_error && message.num_turns === 0) {
            confirm?.()
          }
          continue
        }
        if (turnBroker) for (const event of await translateClaude(message, runtime, tasks, turnBroker)) yield event
      }
    } finally {
      stream.close()
      await Promise.all(processes.map((child) => child.retire({ at: Date.now() + 5_000, signal: new AbortController().signal })))
    }
  }
}

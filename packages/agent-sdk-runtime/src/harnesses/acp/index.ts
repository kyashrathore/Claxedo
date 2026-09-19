/**
 * ACP harness adapter
 *
 * Drives ACP-compatible agents through @agentclientprotocol/sdk and a swappable
 * ACP transport. The default transport is local stdio, but callers can inject
 * another transport implementation.
 *
 * Keeps one ACP process per harness/workspace/config key, lazily spawned and
 * idle-disposed after CLAXEDO_ACP_IDLE_TIMEOUT_MS. Many local sessions can bind
 * to provider ACP sessions inside that one process. A separate probe process
 * discovers config options without blocking active sessions.
 *
 * Persists session mappings and replay events through an injected
 * AcpRuntimeStore; the host owns the concrete backing store.
 *
 * Runtime flow:
 *   ACP session/update → agent-event-runtime ACP translator → turn projector → compat/SSE events
 *   prompt stopReason  → session status / finish events when terminal
 *   requestPermission  → compat permission request, resolved by respondPermission()
 */

import { randomUUID } from "crypto"
import {
  assertAgentExecutionBinding,
  type AgentExecutionBinding,
} from "@claxedo/agent-runtime-contract"
import type { RuntimeEventHub } from "../../runtime-event-hub"
import type {
  AgentAgent,
  AgentCommand,
  AgentMessage,
  AgentPermission,
  AgentSession,
  SessionConfig,
  SessionConfigUpdate,
} from "../../index"
import type {
  AbortResult,
  AgentHarnessAdapter,
  AgentHarnessAdapterHealth,
  AgentHarnessAdapterHealthContext,
  AgentInteractionResult,
  AgentGoalMutationResult,
  AgentGoalResource,
  AgentHarnessAdapterProcessOptions,
  AgentConfigOptions,
  AgentPermissionModeState,
  AgentSessionCreateOptions,
} from "../../adapter-contract"
import { goalCapabilities, type HarnessCapabilities, type HarnessCapabilityContext } from "../../capabilities"
import { acpRuntimeHealth } from "./health"
import {
  acpConfigOptions,
  acpProcessOptions,
  draftPermissionModes,
  extractAgents,
  rememberLiveModes,
  type AcpConfigOptions,
} from "./session"
import { permissionOptionPreference } from "./permission-options"
import { answerAcpPermission } from "./permission-grants"
import { cancelPendingPermissions, commitPermissionReply, type PermissionReplyPort } from "./permission-reply"
import { listCommands } from "../../command-discovery"
import { Log } from "../../log"
import { resolvedMcpServers, toAcpMcpServers } from "../../mcp-resolver"
import { firstPartyMcpProvider } from "../../first-party-mcp"
import { requireWorkspaceDirectory } from "../../target"
import type { ACPProcess } from "./process"
import {
  type ACPConnection,
  type ACPTransportEnv,
  type ACPTransportFactory,
} from "./transport"
import { acpHarnessCapabilities, acpSessionConfig } from "./capabilities"
import {
  envFromConfig,
  errorMessage,
  mergeAcpEnv,
  probeTimeoutMs,
  sameAcpEnv,
  sameAcpMcp,
} from "./helpers"
import type { AgentRuntimeStoreWithRecovery } from "../shared/runtime-store"
import { AcpTurnRunner, activeAcpPromptCount, waitForNoActiveAcpPrompts } from "./turn-runner"
import { type RuntimeGoalSnapshot } from "@claxedo/agent-event-runtime"
import { createGoalPublisher, type GoalPublisher } from "../shared/goal-publisher"
import { acceptedSessionConfig } from "../shared/accepted-session-mutation"

const log = Log.create({ service: "acp-adapter" })

export type AcpRuntimeStore = AgentRuntimeStoreWithRecovery

export type AcpHarnessAdapterOptions = AgentHarnessAdapterProcessOptions & {
  connection: ACPConnection
  harness: string
  storeRoot?: string
  store?: AcpRuntimeStore
  createStore?: (storeRoot?: string) => AcpRuntimeStore
  eventHub?: RuntimeEventHub
  createTransport?: ACPTransportFactory
}

export {
  createACPTransportFactory,
  createStreamableHttpACPTransportFactory,
  createWebSocketACPTransportFactory,
} from "./transport"
export type {
  ACPConnection,
  ACPProcessConnection,
  ACPStreamableHttpConnection,
  ACPTransport,
  ACPTransportEnv,
  ACPTransportFactory,
  ACPTransportFactoryInput,
  ACPStreamableHttpTransportFactoryOptions,
  ACPWebSocketTransportFactoryOptions,
  ACPWebSocketConnection,
} from "./transport"

export class AcpHarnessAdapter extends AcpTurnRunner implements AgentHarnessAdapter {
  readonly adapterCapabilities = ["runtime-config"] as const
  // `blocks` leads the prompt with the system text under
  // `annotations.audience: ["assistant"]`; ACP has no separate instruction slot.
  readonly instructionChannel = "prompt-prefix" as const
  readonly commitsStreamEvents = true
  private goalPublisher?: GoalPublisher
  readonly goals: AgentGoalResource = this.goalResource()

  /**
   * Built on first publication, like the sibling Goal maps on the turn runner.
   * A field initializer would read `this.options` before it exists on instances
   * that skip the constructor, and nothing that only RETIRES publisher state
   * needs the publisher to have been built at all.
   */
  private publisher(): GoalPublisher {
    return this.goalPublisher ??= createGoalPublisher(this.options.eventHub)
  }
  private cfg(model?: SessionConfig["model"]) { return acpSessionConfig(this.harnessId(), this.currentModel, model) }

  readHarnessCapabilities(_directory?: string, context?: HarnessCapabilityContext): HarnessCapabilities {
    return acpHarnessCapabilities({
      harness: this.harnessId(),
      fork: this.supportsForkCapability(context?.sessionId),
      goals: this.supportsGoalCapability(context?.sessionId),
    })
  }

  private publishGoal(sessionId: string, directory: string, goal: RuntimeGoalSnapshot | null) {
    this.publisher().publish({
      sessionId,
      directory,
      agentSessionId: this.store.getAgentSessionId(sessionId) ?? undefined,
      goal,
      applyState: (next) => {
        const previous = this.store.getGoal?.(sessionId)
        this.store.setGoal?.(sessionId, next)
        const advancedIteration = next?.status === "active"
          && previous?.status === "active"
          && next.iteration !== undefined
          && previous.iteration !== undefined
          && next.iteration !== previous.iteration
        if (!next || next.status !== "active" || advancedIteration) this.finishGoalProjection(sessionId)
      },
    })
  }

  private bindGoalListeners(sessionId: string, directory: string, agentSessionId: string, proc: ACPProcess) {
    proc.listenGoal(agentSessionId, sessionId, (goal) => this.publishGoal(sessionId, directory, goal))
    proc.listenGoalUpdates(agentSessionId, (update) => {
      this.observeGoalSessionUpdate(sessionId, agentSessionId, directory, proc, update)
    })
  }

  /**
   * Goal target for a session whose agent is ALREADY running.
   *
   * Returns null instead of spawning. Reads (capabilities and Goal state) go
   * through here so that merely activating a session — which the app does on
   * every open, to render the composer dock — never resurrects an idle-reaped
   * agent binary. Only Goal actions pay that cost, through `goalTarget`.
   */
  private liveGoalTarget(sessionId: string, directory: string | undefined) {
    const required = requireWorkspaceDirectory(directory)
    const agentSessionId = this.store.getAgentSessionId(sessionId)
    const proc = this.entryForSession(sessionId)?.proc
    if (!agentSessionId || !proc?.alive) return null
    this.bindGoalListeners(sessionId, required, agentSessionId, proc)
    return { agentSessionId, directory: required, proc }
  }

  /** Goal target for ACTIONS: spawns the agent when it has been idle-reaped. */
  private async goalTarget(sessionId: string, directory: string) {
    const required = requireWorkspaceDirectory(directory)
    const agentSessionId = this.store.getAgentSessionId(sessionId)
    if (!agentSessionId) throw new Error(`Session ${sessionId} has no ACP session binding`)
    const { proc } = await this.getOrSpawnProcess(sessionId, required)
    this.bindGoalListeners(sessionId, required, agentSessionId, proc)
    return { agentSessionId, directory: required, proc }
  }

  private goalResource(): AgentGoalResource {
    const mutate = async <T extends RuntimeGoalSnapshot | null>(
      sessionId: string,
      directory: string,
      operation: (target: Awaited<ReturnType<AcpHarnessAdapter["goalTarget"]>>) => Promise<T>,
    ): Promise<AgentGoalMutationResult<T>> => {
      try {
        const target = await this.goalTarget(sessionId, directory)
        const goal = await operation(target)
        this.publishGoal(sessionId, target.directory, goal)
        return { ok: true, goal }
      } catch (cause) {
        return {
          ok: false,
          status: "failed",
          message: errorMessage(cause),
        }
      }
    }
    return {
      readCapabilities: async (sessionId, directory) => {
        const unavailable = (unavailableReason: string) => goalCapabilities({
          implemented: false,
          available: false,
          unavailableReason,
          actions: [],
          recovery: "blocked",
          optionalFields: [],
        })
        try {
          const target = this.liveGoalTarget(sessionId, directory)
          if (!target) return unavailable("The ACP agent for this session is not running")
          return goalCapabilities(target.proc.goalCapabilities())
        } catch (cause) {
          return unavailable(errorMessage(cause))
        }
      },
      read: async (sessionId, directory) => {
        const target = this.liveGoalTarget(sessionId, directory)
        // No live agent: the store projection is the last state the agent
        // reported, and answering from it keeps a session open from costing a
        // process spawn plus a full ACP initialize.
        if (!target) return this.store.getGoal?.(sessionId) ?? null
        const goal = await target.proc.readGoal(target.agentSessionId, sessionId)
        this.store.setGoal?.(sessionId, goal)
        return goal
      },
      start: (sessionId, input, directory) => mutate(sessionId, requireWorkspaceDirectory(directory), async (target) => {
        const goal = await target.proc.startGoal(target.agentSessionId, sessionId, input.objective)
        if (!goal) throw new Error("ACP Goal start returned no Goal")
        return goal
      }),
      pause: (sessionId, directory) => mutate(sessionId, requireWorkspaceDirectory(directory), async (target) => {
        const goal = await target.proc.goalAction("pause", target.agentSessionId, sessionId)
        if (!goal) throw new Error("ACP Goal pause returned no Goal")
        return goal
      }),
      resume: (sessionId, directory) => mutate(sessionId, requireWorkspaceDirectory(directory), async (target) => {
        const resumed = await target.proc.goalAction("resume", target.agentSessionId, sessionId)
        const refreshed = await target.proc.readGoal(target.agentSessionId, sessionId)
        const goal = refreshed ?? resumed
        if (!goal) throw new Error("ACP Goal resume returned no Goal")
        return goal
      }),
      stop: (sessionId, directory) => mutate(sessionId, requireWorkspaceDirectory(directory), (target) =>
        target.proc.stopGoal(target.agentSessionId, sessionId)),
      delete: (sessionId, directory) => mutate(sessionId, requireWorkspaceDirectory(directory), async (target) => {
        await target.proc.goalAction("delete", target.agentSessionId, sessionId)
        return null
      }),
    }
  }

  async listSessions(directory: string): Promise<AgentSession[]> {
    directory = requireWorkspaceDirectory(directory)
    return this.store.listSessions(directory)
  }

  async getSession(binding: AgentExecutionBinding): Promise<AgentSession | null> {
    assertAgentExecutionBinding(binding)
    return this.store.getSession(binding.sessionId) ?? null
  }

  async createSession(
    directory: string,
    title?: string,
    id: string = randomUUID(),
    options: AgentSessionCreateOptions = {},
  ): Promise<{ id: string }> {
    directory = requireWorkspaceDirectory(directory)
    log.info("createSession: start", { directory, title, transport: this.connection().kind })
    if (this.store.getSession(id)) return { id }
    const processKey = this.processKey(directory)
    this.sessionProcessMap().set(id, processKey)
    const { proc } = await this.getOrSpawnProcess(id, directory)
    const agentSessionId = await this.boot(proc, directory, title, id)
    log.info("createSession: ACP session created", { id, agentSessionId })
    this.store.bindSession({
      sessionId: id,
      directory,
      title,
      agentSessionId,
      ownerKey: processKey,
    })
    this.store.updateSessionConfig(id, {
      harness: {
        id: this.harnessId(),
        access: "connection",
      },
      ...(this.currentModel ? { model: this.cfg() } : {}),
      variant: null,
      agent: null,
      ...(options.instructions ? { instructions: options.instructions } : {}),
      ...(options.group ? { group: options.group } : {}),
    })
    log.info("createSession: local session stored", { id, agentSessionId })
    return { id }
  }

  async createHandoffSession(directory: string, title: string | undefined, id: string) {
    directory = requireWorkspaceDirectory(directory)
    const processKey = this.processKey(directory)
    this.sessionProcessMap().set(id, processKey)
    const { proc } = await this.getOrSpawnProcess(id, directory)
    const agentSessionId = await this.boot(proc, directory, title, id)
    this.store.bindSession({ sessionId: id, directory, title, agentSessionId, ownerKey: processKey })
    let rolledBack = false
    return {
      id,
      agentSessionId,
      ownerKey: processKey,
      rollback: async () => {
        if (rolledBack) return
        this.releaseSessionProcess(id, processKey)
        rolledBack = true
      },
    }
  }

  async updateSession(binding: AgentExecutionBinding, updates: { title?: string; time?: { archived?: number } }): Promise<AgentSession | null> {
    assertAgentExecutionBinding(binding)
    return this.store.updateSession(binding.sessionId, updates)
  }

  async getSessionConfig(binding: AgentExecutionBinding): Promise<SessionConfig> {
    assertAgentExecutionBinding(binding)
    return this.store.getSessionConfig(binding.sessionId) ?? {
      harness: {
        id: this.harnessId(),
        access: "connection",
      },
      ...(this.currentModel ? { model: this.cfg() } : {}),
      variant: null,
      agent: null,
    }
  }

  async updateSessionConfig(binding: AgentExecutionBinding, update: SessionConfigUpdate): Promise<SessionConfig> {
    assertAgentExecutionBinding(binding)
    const id = binding.sessionId
    requireWorkspaceDirectory(binding.directory)
    const current = this.store.getSessionConfig(id)
    if (!current) throw new Error(`Session ${id} has no runtime config`)
    const next = acceptedSessionConfig(current, update)
    if (update.model !== undefined) {
      this.setModel(next.model?.modelID === "default" ? "" : next.model?.modelID ?? "")
    }
    const proc = this.entryForSession(id)?.proc
    const agentSessionId = this.store.getAgentSessionId(id)
    if (!proc?.alive || !agentSessionId) return next
    await proc.syncSession(agentSessionId, {
      parts: [],
      assistantMessageId: "cfg",
      agent: next.agent ?? "build",
      model: this.cfg(next.model),
      ...(next.variant ? { variant: next.variant } : {}),
    })
    return next
  }

  async deleteSession(binding: AgentExecutionBinding): Promise<void> {
    assertAgentExecutionBinding(binding)
    const id = binding.sessionId
    this.finishGoalProjection(id)
    const key = this.sessionProcessMap().get(id) ?? this.store.getSessionOwnerKey?.(id)
    this.releaseSessionProcess(id, key)
  }

  async releaseHandoffSource(
    id: string,
    agentSessionId: string,
    ownerKey: string | null,
    _directory: string,
  ): Promise<void> {
    this.finishGoalProjection(id)
    this.releaseSessionProcess(id, ownerKey, agentSessionId)
  }

  private releaseSessionProcess(
    id: string,
    key: string | null | undefined,
    boundAgentSessionId?: string,
  ): void {
    const entry = key ? this.processMap().get(key) : undefined
    const agentSessionId = boundAgentSessionId ?? this.store.getAgentSessionId(id)
    if (agentSessionId) entry?.proc?.unlistenGoal(agentSessionId)
    // Nothing published means nothing to retire; never build a publisher here.
    this.goalPublisher?.forget(id)
    entry?.sessionIds.delete(id)
    this.sessionProcessMap().delete(id)
    const persistedSiblings = key
      ? (this.store.listSessionsByOwnerKey?.(key) ?? []).filter((sessionId) => sessionId !== id)
      : []
    if (key && entry && entry.sessionIds.size === 0 && persistedSiblings.length === 0) {
      entry.proc?.dispose()
      this.processMap().delete(key)
    }
  }

  async getMessages(binding: AgentExecutionBinding): Promise<AgentMessage[]> {
    assertAgentExecutionBinding(binding)
    return this.store.getMessages(binding.sessionId)
  }

  async abort(binding: AgentExecutionBinding): Promise<AbortResult> {
    assertAgentExecutionBinding(binding)
    const { sessionId: id } = binding
    const directory = requireWorkspaceDirectory(binding.directory)
    log.info("abort: called", { id, directory })
    const agentSessionId = this.store.getAgentSessionId(id)
    if (!agentSessionId) {
      log.info("abort: session not found in store", { id })
      this.store.markSessionInterrupted(id, "ACP session could not be cancelled because no agent session is attached.")
      return {
        ok: false,
        status: "recovering",
        message: "ACP session could not be cancelled because no agent session is attached.",
      }
    }
    const proc = this.entryForSession(id)?.proc
    if (!proc?.alive) {
      log.info("abort: no alive process for session", { id, directory })
      this.store.markSessionInterrupted(id, "ACP session could not be cancelled because its process is no longer alive.", agentSessionId)
      return {
        ok: false,
        status: "recovering",
        message: "ACP session could not be cancelled because its process is no longer alive.",
      }
    }
    try {
      await proc.cancel(agentSessionId)
      cancelPendingPermissions(this.permissionReplyPort(), proc, id, agentSessionId)
      return { ok: true, status: "cancelled" }
    } catch (err) {
      log.info("abort: cancel failed; disposing session process", { id, directory, err })
      const key = this.sessionProcessMap().get(id) ?? this.store.getSessionOwnerKey?.(id) ?? this.processKey(directory)
      this.invalidateProcess(key, "ACP session cancellation failed; the agent process was stopped.", proc)
      return {
        ok: false,
        status: "recovering",
        message: "ACP session cancellation failed; the agent process was stopped.",
      }
    }
  }

  async forkSession(binding: AgentExecutionBinding, _messageId: string, childSessionId?: string): Promise<{ id: string }> {
    assertAgentExecutionBinding(binding)
    const id = binding.sessionId
    const directory = requireWorkspaceDirectory(binding.directory)
    log.info("forkSession: called", { id, directory })
    const session = this.store.getSession(id)
    const agentSessionId = this.store.getAgentSessionId(id)
    if (!session || !agentSessionId) throw new Error(`Session ${id} not found`)

    const result = await this.getOrSpawnProcess(id, directory)
    const proc = result.proc
    if (result.isNew) {
      await proc.resumeSession(agentSessionId, directory, id)
    }
    if (!proc.supportsForkSession(agentSessionId)) {
      throw new Error("ACP agent does not advertise session fork support")
    }
    const newId = childSessionId ?? randomUUID()
    const newAgentSessionId = await proc.forkSession(agentSessionId, directory, newId)
    log.info("forkSession: ACP fork succeeded", { newAgentSessionId })

    const processKey = this.sessionProcessMap().get(id)
      ?? this.store.getSessionOwnerKey?.(id)
      ?? (this.options ? this.keyForSession(id, directory) : null)
    if (processKey) {
      this.sessionProcessMap().set(newId, processKey)
      this.process(processKey, directory).sessionIds.add(newId)
    }
    this.store.bindSession({
      sessionId: newId,
      directory,
      title: session.title ?? undefined,
      agentSessionId: newAgentSessionId,
      ...(processKey ? { ownerKey: processKey } : {}),
    })
    log.info("forkSession: done", { newId, newAgentSessionId })
    return { id: newId }
  }

  async listCommands(_directory: string): Promise<AgentCommand[]> {
    return listCommands()
  }

  async listAgents(directory: string): Promise<AgentAgent[]> {
    directory = requireWorkspaceDirectory(directory)
    for (const entry of this.processEntries()) {
      const proc = entry.proc
      if (!proc?.alive) continue
      const list = proc.getAgents()
      if (list.length > 0) return list
    }
    const probe = this.probe?.proc
    if (probe?.alive) {
      const list = probe.getAgents()
      if (list.length > 0) return list
    }
    const cfg = await this.probeAcpConfigOptions(directory)
    if (cfg.options.length > 0) {
      const list = extractAgents({
        caps: null,
        prompt: null,
        cfg: cfg.options,
        modes: [],
      })
      if (list.length > 0) return list
    }
    throw new Error("ACP harness did not return live agent options")
  }

  /**
   * Permission modes for a Claxedo session.
   *
   * Two things must both be true before an agent can answer: it has to have been
   * booted (so there is a process) and a `session/new` must have happened (so
   * there is an agent session id whose state holds the advertised modes). Before
   * that this reports NO modes and NO `unsupported` — the caller renders that as
   * "not reported yet", which is the truth, rather than as "this agent has none".
   */
  async listDraftPermissionModes(directory: string): Promise<AgentPermissionModeState> {
    requireWorkspaceDirectory(directory)
    return draftPermissionModes(this.harnessId())
  }

  async listPermissionModes(binding: AgentExecutionBinding): Promise<AgentPermissionModeState> {
    assertAgentExecutionBinding(binding)
    const { sessionId } = binding
    requireWorkspaceDirectory(binding.directory)
    const agentSessionId = this.store.getAgentSessionId(sessionId)
    const proc = this.entryForSession(sessionId)?.proc
    // No agent session yet: show what this agent version is KNOWN to offer, by
    // its own ids and names, so the draft choice survives the first message
    // unchanged. An agent we have never probed reports nothing rather than a
    // plausible-looking guess.
    if (!agentSessionId || !proc?.alive) return draftPermissionModes(this.harnessId())
    const state = proc.permissionModes(agentSessionId)
    // Teach later drafts what this user's agent actually offers, so the recorded
    // seed stops being consulted for a build it may not describe.
    rememberLiveModes(this.harnessId(), state)
    return state
  }

  async setPermissionMode(binding: AgentExecutionBinding, modeId: string): Promise<AgentPermissionModeState> {
    assertAgentExecutionBinding(binding)
    const { sessionId } = binding
    requireWorkspaceDirectory(binding.directory)
    const agentSessionId = this.store.getAgentSessionId(sessionId)
    const proc = this.entryForSession(sessionId)?.proc
    // Deliberately a THROW rather than a silent no-op: a permission write that
    // quietly does nothing is the exact failure this whole channel exists to
    // prevent, and the caller surfaces it.
    if (!agentSessionId || !proc?.alive) {
      throw new Error("ACP session has no live agent session to set a permission mode on")
    }
    return proc.setPermissionMode(agentSessionId, modeId)
  }

  async getTodos(binding: AgentExecutionBinding): Promise<Array<{ content: string; status: string; priority: string }>> {
    assertAgentExecutionBinding(binding)
    return this.store.getTodos(binding.sessionId)
  }

  async listPermissions(directory: string): Promise<AgentPermission[]> {
    directory = requireWorkspaceDirectory(directory)
    const rows = this.store.listPermissions(directory)
    const live = rows.filter((row) => {
      const proc = this.permissionProcess(row.id, row.sessionID)
      if (proc?.alive && proc.pendingPermissions.has(row.id)) return true
      this.permissionOwnerMap().delete(row.id)
      return false
    })
    log.info("listPermissions", { count: rows.length, live: live.length })
    return live
  }

  async respondPermission(
    binding: AgentExecutionBinding,
    permId: string,
    decision: "allow_once" | "allow_always" | "deny" | "reject_always",
  ): Promise<AgentInteractionResult | void> {
    assertAgentExecutionBinding(binding)
    const directory = requireWorkspaceDirectory(binding.directory)
    log.info("respondPermission: called", { permId, decision, directory })
    const row = (this.store.listPermissions(directory) as Array<{ id: string; sessionID: string }>).find(
      (item) => item.id === permId && item.sessionID === binding.sessionId,
    )
    if (!row) throw new Error(`Permission ${permId} does not belong to session ${binding.sessionId}`)
    const clear = () => commitPermissionReply(this.permissionReplyPort(), {
      sessionId: row.sessionID,
      permId,
      reply: decision === "allow_always" ? "always" : decision === "allow_once" ? "once" : "reject",
      source: { dir: "out", method: "permission.reply", frame: { decision } },
    })
    const proc = this.permissionProcess(permId, row.sessionID)
    if (!proc?.alive) {
      log.info("respondPermission: no alive process for permission session", {
        directory,
        permId,
        sessionId: row?.sessionID,
      })
      return clear()
    }
    const pending = proc.pendingPermissions.get(permId)
    if (!pending) {
      log.info("respondPermission: permId not found in pending map", {
        permId,
        knownPermIds: [...proc.pendingPermissions.keys()],
      })
      return clear()
    }
    const option = answerAcpPermission(this.store, row.sessionID, decision, pending)
    if (option) {
      log.info("respondPermission: resolving with option", {
        permId,
        decision,
        requestedKind: permissionOptionPreference(decision)[0],
        selectedOptionId: option.optionId,
        selectedKind: option.kind,
        // Loud when we had to settle for something other than first choice.
        degraded: option.kind !== permissionOptionPreference(decision)[0],
      })
      proc.respondPermission(permId, { outcome: { outcome: "selected", optionId: option.optionId } })
      return clear()
    }
    log.info("respondPermission: no acceptable option found in pending.options", {
      permId,
      decision,
      preferred: permissionOptionPreference(decision),
      availableKinds: pending.options.map((o) => o.kind),
    })
    proc.respondPermission(permId, { outcome: { outcome: "cancelled" } })
    return clear()
  }

  private permissionReplyPort(): PermissionReplyPort {
    return { store: this.store, owners: this.permissionOwnerMap() }
  }

  private permissionProcess(permId: string, sessionId: string): ACPProcess | undefined {
    const owner = this.permissionOwnerMap().get(permId)
    if (owner?.alive && owner.pendingPermissions.has(permId)) return owner
    const bound = this.entryForSession(sessionId)?.proc
    if (bound?.alive && bound.pendingPermissions.has(permId)) return bound
    for (const entry of this.processEntries()) {
      const proc = entry.proc
      if (proc?.alive && proc.pendingPermissions.has(permId)) return proc
    }
    return undefined
  }

  async applyConfig(config: Record<string, unknown>): Promise<void> {
    // Read before the unchanged-config short-circuit: the provider is not part
    // of the effective config a restart decision compares, but a launch that
    // happens without it hands the harness no first-party entry at all.
    this.firstPartyMcp = firstPartyMcpProvider(config)
    const mcp = resolvedMcpServers(config.mcp)
    // Gating here keeps `currentMcp` empty for the whole adapter lifetime:
    // session requests, process fingerprints, restart decisions, and process
    // observation all read it, so nothing downstream needs its own check.
    const nextMcp = this.connection().supportsMcpServers === false ? [] : toAcpMcpServers(mcp ?? {})
    const nextEnv = mergeAcpEnv(this.currentEnv, envFromConfig(config))
    const unchanged = sameAcpMcp(this.currentMcp, nextMcp) && sameAcpEnv(this.currentEnv, nextEnv)
    if (unchanged && !this.configRestartPending) {
      log.info("ACP config apply skipped restart because effective config is unchanged", {
        keys: Object.keys(config),
        harness: this.harnessId(),
        transport: this.connection().kind,
      })
      return
    }
    if (this.lifecycle().activeTurns.size > 0 || activeAcpPromptCount(this.harnessId()) > 0) {
      this.currentMcp = nextMcp
      this.currentEnv = nextEnv
      this.configRestartPending = true
      log.info("ACP config apply deferred restart because a prompt is active", {
        keys: Object.keys(config),
        harness: this.harnessId(),
        transport: this.connection().kind,
      })
      return
    }
    this.currentMcp = nextMcp
    this.currentEnv = nextEnv
    this.configRestartPending = false
    this.restart()
    this.forgetSessionProcessBindings()
    log.info("Applied config in-memory, restarted ACP process", {
      keys: Object.keys(config),
      harness: this.harnessId(),
      transport: this.connection().kind,
    })
  }

  async waitForConfigReady(): Promise<void> {
    while (this.configRestartPending && activeAcpPromptCount(this.harnessId()) > 0) {
      await waitForNoActiveAcpPrompts(this.harnessId())
    }
    if (!this.configRestartPending) return
    this.configRestartPending = false
    this.restart()
    this.forgetSessionProcessBindings()
    log.info("Applied deferred ACP config after active prompts completed", {
      harness: this.harnessId(),
      transport: this.connection().kind,
    })
  }

  peekConfigOptions(directory: string): AgentConfigOptions | null {
    const probed = this.peekAcpConfigOptions(directory)
    return probed ? acpConfigOptions(probed) : null
  }
  /** The agent's own answers, for the ACP-shaped readers in `./session`. */
  peekAcpConfigOptions(_directory: string): AcpConfigOptions | null {
    for (const entry of this.processEntries()) {
      const proc = entry.proc
      if (proc?.alive && proc.cachedConfigOptions) return acpProcessOptions(proc)
    }
    const proc = this.probe?.proc
    if (proc?.alive && proc.cachedConfigOptions) return acpProcessOptions(proc)
    return null
  }

  async probeConfigOptions(directory: string): Promise<AgentConfigOptions> {
    return acpConfigOptions(await this.probeAcpConfigOptions(directory))
  }

  /** The agent's own answers, probing a process if none is cached. */
  async probeAcpConfigOptions(directory: string): Promise<AcpConfigOptions> {
    directory = requireWorkspaceDirectory(directory)
    const live = this.peekAcpConfigOptions(directory)
    if (live) {
      log.info("probeConfigOptions: returning cached options from existing process")
      return live
    }
    if (activeAcpPromptCount(this.harnessId()) > 0) {
      throw new Error("ACP harness config options are temporarily unavailable while a prompt is active")
    }
    const wait = async <T>(label: string, run: Promise<T>) => {
      const ms = probeTimeoutMs()
      let id: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([
          run,
          new Promise<T>((_, reject) => {
            id = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
          }),
        ])
      } finally {
        if (id) clearTimeout(id)
      }
    }
    try {
      const proc = await wait("ACP mode probe", this.getOrSpawnProbe(directory))
      if (proc.cachedConfigOptions) return acpProcessOptions(proc)
      await this.boot(proc, directory, undefined, undefined, probeTimeoutMs())
      if (!proc.cachedConfigOptions) {
        const ms = probeTimeoutMs()
        await wait("ACP mode cache", new Promise<void>((resolve) => {
          let check: ReturnType<typeof setInterval> | undefined
          const done = () => {
            clearTimeout(timeout)
            if (check) clearInterval(check)
            resolve()
          }
          const timeout = setTimeout(done, ms)
          check = setInterval(() => {
            if (proc.cachedConfigOptions) {
              done()
            }
          }, 100)
        }))
      }
      if (!proc.cachedConfigOptions) throw new Error("ACP harness did not return live config options")
      return acpProcessOptions(proc)
    } catch (err) {
      log.warn("probeConfigOptions: failed", {
        directory,
        error: errorMessage(err),
      })
      throw err
    }
  }

  readRuntimeHealth(directory: string, context?: AgentHarnessAdapterHealthContext): AgentHarnessAdapterHealth {
    return acpRuntimeHealth({
      store: this.store,
      harnessId: this.harnessId(),
      activeTurns: this.lifecycle().activeTurns,
      directory: requireWorkspaceDirectory(directory),
      ...(context ? { context } : {}),
    })
  }

  dispose(): void {
    log.info("AcpHarnessAdapter dispose: disposing ACP processes", {
      processes: this.processMap().size,
      harness: this.harnessId(),
      transport: this.connection().kind,
    })
    this.restart()
    this.processMap().clear()
    this.sessionProcessMap().clear()
    this.probe = null
    this.closeStore()
  }
}

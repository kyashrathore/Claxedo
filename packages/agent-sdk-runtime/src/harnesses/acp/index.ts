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
  type SessionConfigOption,
} from "@agentclientprotocol/sdk"
import {
  permissionReplied,
} from "../../compat-events"
import type { RuntimeEventHub } from "../../runtime-event-hub"
import type {
  AgentAgent,
  AgentCommand,
  AgentConfigOption,
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
  AgentHarnessAdapterProcessOptions,
  AgentPermissionModeState,
} from "../../adapter-contract"
import { harnessCapabilities, type HarnessCapabilities, type HarnessCapabilityContext } from "../../capabilities"
import { draftPermissionModes, extractAgents, rememberLiveModes } from "./session"
import { permissionOptionPreference, selectPermissionOption } from "./permission-options"
import { listCommands } from "../../command-discovery"
import { Log } from "../../log"
import { toAcpMcpServers, type ResolvedMcpServer } from "../../mcp-resolver"
import { requireWorkspaceDirectory } from "../../target"
import {
  type ACPTransportEnv,
  type ACPTransportFactory,
} from "./transport"
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

const log = Log.create({ service: "acp-adapter" })

export type AcpRuntimeStore = AgentRuntimeStoreWithRecovery

export type AcpHarnessAdapterOptions = AgentHarnessAdapterProcessOptions & {
  binary: string
  harness: string
  args?: string[]
  env?: ACPTransportEnv
  /**
   * `false` keeps MCP servers out of everything offered to this agent —
   * session requests, process fingerprints, and process observation. See
   * `ProcessHarnessConnection.supportsMcpServers`.
   */
  supportsMcpServers?: boolean
  storeRoot?: string
  store?: AcpRuntimeStore
  createStore?: (storeRoot?: string) => AcpRuntimeStore
  eventHub?: RuntimeEventHub
  createTransport?: ACPTransportFactory
}

export {
  createHttpACPTransportFactory,
  createStreamableHttpACPTransportFactory,
  createWebSocketACPTransportFactory,
} from "./transport"
export type {
  ACPHttpTransportFactoryOptions,
  ACPTransport,
  ACPTransportEnv,
  ACPTransportFactory,
  ACPTransportFactoryInput,
  ACPStreamableHttpTransportFactoryOptions,
  ACPWebSocketTransportFactoryOptions,
} from "./transport"

export class AcpHarnessAdapter extends AcpTurnRunner implements AgentHarnessAdapter {
  readonly adapterCapabilities = ["runtime-config"] as const
  readonly commitsStreamEvents = true
  private cfg(model?: SessionConfig["model"]) {
    if (model) return model
    if (this.currentModel) {
      return {
        providerID: this.harnessId(),
        modelID: this.currentModel,
      }
    }
    return {
      providerID: this.harnessId(),
      modelID: "default",
    }
  }

  private supportsFork(sessionId?: string) {
    if (sessionId) {
      const entry = this.entryForSession(sessionId)
      if (!entry?.proc?.alive) return false
      return entry.proc.supportsForkSession(this.store.getAgentSessionId(sessionId) ?? undefined)
    }
    for (const entry of this.processEntries()) {
      if (entry.proc?.alive && entry.proc.supportsForkSession()) return true
    }
    return !!this.probe?.proc?.alive && this.probe.proc.supportsForkSession()
  }

  readHarnessCapabilities(_directory?: string, context?: HarnessCapabilityContext): HarnessCapabilities {
    return harnessCapabilities({
      harness: this.harnessId(),
      abort: true,
      reconnect: false,
      replay: true,
      permissions: true,
      questions: false,
      todos: false,
      commands: false,
      fork: this.supportsFork(context?.sessionId),
      revert: false,
      unrevert: false,
      configOptions: true,
      subagents: false,
    })
  }

  async listSessions(directory: string): Promise<AgentSession[]> {
    directory = requireWorkspaceDirectory(directory)
    return this.store.listSessions(directory) as AgentSession[]
  }

  async getSession(id: string, _directory: string): Promise<AgentSession | null> {
    return this.store.getSession(id) as AgentSession | null
  }

  async createSession(directory: string, title?: string, id: string = randomUUID()): Promise<{ id: string }> {
    directory = requireWorkspaceDirectory(directory)
    log.info("createSession: start", { directory, title, binary: this.options.binary })
    if (this.store.getSession(id)) return { id }
    const processKey = this.processKey(directory)
    this.sessionProcessMap().set(id, processKey)
    const { proc } = await this.getOrSpawnProcess(id, directory)
    const agentSessionId = await this.boot(proc, directory, title)
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
        access: "acp",
      },
      ...(this.currentModel ? { model: this.cfg() } : {}),
      variant: null,
      agent: null,
    })
    log.info("createSession: local session stored", { id, agentSessionId })
    return { id }
  }

  async createHandoffSession(directory: string, title: string | undefined, id: string) {
    directory = requireWorkspaceDirectory(directory)
    const processKey = this.processKey(directory)
    this.sessionProcessMap().set(id, processKey)
    const { proc } = await this.getOrSpawnProcess(id, directory)
    const agentSessionId = await this.boot(proc, directory, title)
    this.store.bindSession({ sessionId: id, directory, title, agentSessionId, ownerKey: processKey })
    return { id, agentSessionId, ownerKey: processKey }
  }

  async updateSession(id: string, updates: { title?: string; time?: { archived?: number } }, _directory: string): Promise<AgentSession | null> {
    return this.store.updateSession(id, updates) as AgentSession | null
  }

  async getSessionConfig(id: string, _directory: string): Promise<SessionConfig> {
    return this.store.getSessionConfig(id) ?? {
      harness: {
        id: this.harnessId(),
        access: "acp",
      },
      ...(this.currentModel ? { model: this.cfg() } : {}),
      variant: null,
      agent: null,
    }
  }

  async updateSessionConfig(id: string, update: SessionConfigUpdate, directory: string): Promise<SessionConfig> {
    directory = requireWorkspaceDirectory(directory)
    const previous = this.store.getSessionConfig(id)
    const next = this.store.updateSessionConfig(id, update) ?? await this.getSessionConfig(id, directory)
    try {
      if (next.model?.modelID) {
        this.setModel(next.model.modelID === "default" ? "" : next.model.modelID)
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
    } catch (error) {
      if (previous) {
        this.store.updateSessionConfig(id, {
          harness: previous.harness,
          model: previous.model ?? null,
          variant: previous.variant ?? null,
          agent: previous.agent ?? null,
          handoff: previous.handoff ?? null,
        })
      }
      throw error
    }
  }

  async deleteSession(id: string, _directory: string): Promise<void> {
    const key = this.sessionProcessMap().get(id) ?? this.store.getSessionOwnerKey?.(id)
    const entry = key ? this.processMap().get(key) : undefined
    entry?.sessionIds.delete(id)
    this.sessionProcessMap().delete(id)
    const persistedSiblings = key
      ? (this.store.listSessionsByOwnerKey?.(key) ?? []).filter((sessionId) => sessionId !== id)
      : []
    if (key && entry && entry.sessionIds.size === 0 && persistedSiblings.length === 0) {
      entry.proc?.dispose()
      this.processMap().delete(key)
    }
    this.store.deleteSession(id)
  }

  async getMessages(id: string, _directory: string): Promise<AgentMessage[]> {
    return this.store.getMessages(id) as AgentMessage[]
  }

  async abort(id: string, directory: string): Promise<AbortResult> {
    directory = requireWorkspaceDirectory(directory)
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

  async forkSession(id: string, _messageId: string, directory: string): Promise<{ id: string }> {
    directory = requireWorkspaceDirectory(directory)
    log.info("forkSession: called", { id, directory })
    const row = this.getSession(id, directory) as Promise<{ agent_session_id?: string; title?: string | null } | null>
    const session = await row
    const agentSessionId = this.store.getAgentSessionId(id)
    if (!session || !agentSessionId) throw new Error(`Session ${id} not found`)

    const result = await this.getOrSpawnProcess(id, directory)
    const proc = result.proc
    if (result.isNew) {
      await proc.resumeSession(agentSessionId, directory)
    }
    if (!proc.supportsForkSession(agentSessionId)) {
      throw new Error("ACP agent does not advertise session fork support")
    }
    const newAgentSessionId = await proc.forkSession(agentSessionId, directory)
    log.info("forkSession: ACP fork succeeded", { newAgentSessionId })

    const newId = randomUUID()
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
    const cfg = await this.probeConfigOptions(directory)
    if (Array.isArray(cfg) && cfg.length > 0) {
      const list = extractAgents({
        caps: null,
        prompt: null,
        cfg: cfg as SessionConfigOption[],
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
  async listPermissionModes(sessionId: string, directory: string): Promise<AgentPermissionModeState> {
    directory = requireWorkspaceDirectory(directory)
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

  async setPermissionMode(sessionId: string, modeId: string, directory: string): Promise<AgentPermissionModeState> {
    directory = requireWorkspaceDirectory(directory)
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

  async getTodos(sessionId: string, _directory: string): Promise<Array<{ content: string; status: string; priority: string }>> {
    return this.store.getTodos(sessionId)
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
    return live as AgentPermission[]
  }

  async respondPermission(
    permId: string,
    decision: "allow_once" | "allow_always" | "deny" | "reject_always",
    directory: string,
  ): Promise<AgentInteractionResult | void> {
    directory = requireWorkspaceDirectory(directory)
    log.info("respondPermission: called", { permId, decision, directory })
    const row = (this.store.listPermissions(directory) as Array<{ id: string; sessionID: string }>).find((item) => item.id === permId)
    const clear = () => {
      this.permissionOwnerMap().delete(permId)
      if (!row) return
      const committed = this.store.appendEvent({
        sessionId: row.sessionID,
        payload: permissionReplied(
          row.sessionID,
          permId,
          decision === "allow_always" ? "always" : decision === "allow_once" ? "once" : "reject",
        ),
        source: {
          dir: "out",
          method: "permission.reply",
          frame: { decision },
        },
      })
      return committed?.payload ? { events: [committed.payload] } : undefined
    }
    const proc = row ? this.permissionProcess(permId, row.sessionID) : undefined
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
    const preferred = permissionOptionPreference(decision)
    const option = selectPermissionOption(decision, pending.options)
    if (option) {
      log.info("respondPermission: resolving with option", {
        permId,
        decision,
        requestedKind: preferred[0],
        selectedOptionId: option.optionId,
        selectedKind: option.kind,
        // Loud when we had to settle for something other than first choice.
        degraded: option.kind !== preferred[0],
      })
      proc.respondPermission(permId, { outcome: { outcome: "selected", optionId: option.optionId } })
      return clear()
    }
    log.info("respondPermission: no acceptable option found in pending.options", {
      permId,
      decision,
      preferred,
      availableKinds: pending.options.map((o) => o.kind),
    })
    proc.respondPermission(permId, { outcome: { outcome: "cancelled" } })
    return clear()
  }

  private permissionProcess(permId: string, sessionId: string) {
    const owner = this.permissionOwnerMap().get(permId)
    if (owner?.alive && owner.pendingPermissions.has(permId)) return owner
    const bound = this.entryForSession(sessionId)?.proc
    if (bound?.alive && bound.pendingPermissions.has(permId)) return bound
    for (const entry of this.processEntries()) {
      const proc = entry.proc
      if (proc?.alive && proc.pendingPermissions.has(permId)) return proc
    }
  }

  async applyConfig(config: Record<string, unknown>): Promise<void> {
    const mcp = config.mcp as Record<string, ResolvedMcpServer> | undefined
    // Gating here keeps `currentMcp` empty for the whole adapter lifetime:
    // session requests, process fingerprints, restart decisions, and process
    // observation all read it, so nothing downstream needs its own check.
    const nextMcp = this.options.supportsMcpServers === false ? [] : toAcpMcpServers(mcp ?? {})
    const nextEnv = mergeAcpEnv(this.currentEnv, envFromConfig(config))
    const unchanged = sameAcpMcp(this.currentMcp, nextMcp) && sameAcpEnv(this.currentEnv, nextEnv)
    if (unchanged && !this.configRestartPending) {
      log.info("ACP config apply skipped restart because effective config is unchanged", {
        keys: Object.keys(config),
        harness: this.harnessId(),
        binary: this.options.binary,
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
        binary: this.options.binary,
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
      binary: this.options.binary,
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
      binary: this.options.binary,
    })
  }

  peekConfigOptions(_directory: string): AgentConfigOption[] | null {
    for (const entry of this.processEntries()) {
      const proc = entry.proc
      if (proc?.alive && proc.cachedConfigOptions) return proc.cachedConfigOptions as AgentConfigOption[]
    }
    const proc = this.probe?.proc
    if (proc?.alive && proc.cachedConfigOptions) return proc.cachedConfigOptions as AgentConfigOption[]
    return null
  }

  async probeConfigOptions(directory: string): Promise<AgentConfigOption[]> {
    directory = requireWorkspaceDirectory(directory)
    const live = this.peekConfigOptions(directory)
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
      if (proc.cachedConfigOptions) return proc.cachedConfigOptions as AgentConfigOption[]
      await this.boot(proc, directory, undefined, probeTimeoutMs())
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
      return proc.cachedConfigOptions as AgentConfigOption[]
    } catch (err) {
      log.warn("probeConfigOptions: failed", {
        directory,
        error: errorMessage(err),
      })
      throw err
    }
  }

  readRuntimeHealth(directory: string, context?: AgentHarnessAdapterHealthContext): AgentHarnessAdapterHealth {
    directory = requireWorkspaceDirectory(directory)
    const recovering = (this.store.listSessions(directory) as Array<{
      id: string
      status?: string | null
      recovery_error?: string | null
      config?: { harness?: SessionConfig["harness"] }
    }>).filter((session) => {
      if (context?.sessionId && session.id !== context.sessionId) return false
      if (session.status !== "recovering") return false
      // RuntimeStore is shared by every harness in a workspace. Health belongs
      // to this adapter only: an old native recovery (or another ACP
      // connection) must not degrade the active operator ACP. Persistent
      // stores project config on the list row; the config lookup keeps the same
      // contract for in-memory/custom stores without inventing ownership.
      const harness = session.config?.harness ?? this.store.getSessionConfig(session.id)?.harness
      return harness?.id === this.harnessId() && harness.access === "acp"
    })
    if (recovering.length > 0) {
      return {
        status: "degraded",
        reason: "harness_process_lost",
        message: recovering[0]?.recovery_error ?? "ACP session process restarted",
        sessions: recovering.map((session) => ({
          id: session.id,
          status: session.status,
          message: session.recovery_error ?? null,
        })),
      }
    }
    return { status: "ok" }
  }

  dispose(): void {
    log.info("AcpHarnessAdapter dispose: disposing ACP processes", {
      processes: this.processMap().size,
      harness: this.harnessId(),
      binary: this.options.binary,
    })
    this.restart()
    this.processMap().clear()
    this.sessionProcessMap().clear()
    this.probe = null
    this.closeStore()
  }
}

import type { AgentAgent, AgentCommand, SessionConfig, SessionConfigUpdate } from "@claxedo/agent-runtime-contract"
import type { AttachInput, ConfigApplied, ConfigOptionsPreview, ConfigPreviewTarget, ConfigTarget, HarnessServices, HarnessSession,
  HarnessTransport, SessionBroker, StartInput, TransportConfigUpdate, TurnBroker, TurnInput, TurnRef, Deadline } from "../../contract"
import { openCodeLaunchDocument } from "../../profiles/opencode/index.js"
import { openCodeCapabilities } from "./capabilities.js"
import { rollbackOpenCodeSession } from "./open-rollback.js"
import { providerOverlays } from "./credentials.js"
import { OpenCodeOwnerMismatchError } from "./errors.js"
import { TransportError } from "../../contract/errors.js"
import { firstPartyTools } from "./first-party-tools.js"
import { eventAssistantMessageID, eventSessionID, terminal } from "./translate/event.js"
import { createOpenCodeRuntime, type OpenCodeRuntime, type OpenCodeRuntimeOptions } from "./runtime.js"
import { WorkspaceScope } from "./scope.js"
import { promptRequest, runOpenCodeTurn } from "./turn.js"
import { createKeyedSerializer, errorMessage, settleAtRequestDeadline } from "@claxedo/helpers"
import { attachedSessionEntry, configOptionsPreview, mergeStartInput, sessionConnectionHealth, sessionMcpServers } from "../../contract"

type Entry = { session: HarnessSession; start: StartInput; broker: SessionBroker; scope: WorkspaceScope;
  upstream: string; active: boolean; assistantMessageID?: string }

export class OpenCodeSdkTransport implements HarnessTransport {
  readonly kind = "opencode-sdk" as const
  private readonly runtime: OpenCodeRuntime
  private readonly entries = new Map<string, Entry>()
  private readonly documents = new Map<string, { content: string; users: Set<string> }>()
  private readonly bindingChanges = createKeyedSerializer()
  private owner?: string
  private disposed = false

  constructor(private readonly services: HarnessServices, options: OpenCodeRuntimeOptions) {
    this.runtime = createOpenCodeRuntime(options)
  }

  private ownerKey(owner: StartInput["owner"]): string {
    return owner.kind === "machine-owner" ? "machine-owner" : `person:${owner.userId}`
  }

  private assertOwner(owner: StartInput["owner"]): void {
    if (this.disposed) throw new TransportError("opencode", "engine", "OpenCode transport is disposed")
    const key = this.ownerKey(owner)
    if (this.owner !== undefined && this.owner !== key) throw new OpenCodeOwnerMismatchError()
  }

  private scope(input: Pick<StartInput, "workspaceId" | "directory">): WorkspaceScope {
    return WorkspaceScope.authorize({ workspaceID: input.workspaceId, directory: input.directory })
  }

  private entry(session: HarnessSession): Entry {
    return attachedSessionEntry(this.entries, session, () => new TransportError("opencode", "session", "OpenCode session is not attached"),
      (entry, current) => entry.start.workspaceId === current.binding.workspaceId)
  }

  private async applyProjection(input: StartInput, scope: WorkspaceScope): Promise<void> {
    const servers = sessionMcpServers(input, this.services, { includeFirstParty: false,
      duplicate: (name) => new Error(`OpenCode MCP server ${name} has conflicting owners`) })
    const document = openCodeLaunchDocument(input.projection, servers)
    const content = JSON.stringify(document)
    const current = this.documents.get(scope.directory)
    if (current && current.content !== content && [...current.users].some((id) => id !== input.sessionId)) {
      throw new TransportError("opencode", "configuration", "OpenCode sessions in one directory require one MCP and skill catalog")
    }
    const store = await this.runtime.launch(scope)
    await store.write(document)
    this.documents.set(scope.directory, { content, users: new Set([...(current?.users ?? []), input.sessionId]) })
  }

  private bindingKey(input: StartInput): string {
    return JSON.stringify(Object.entries(providerOverlays(input.credentials)).sort(([left], [right]) => left.localeCompare(right)))
  }

  private assertBindingCompatible(input: StartInput): void {
    const selected = this.bindingKey(input)
    for (const [id, entry] of this.entries) {
      if (id !== input.sessionId && this.bindingKey(entry.start) !== selected) {
        throw new TransportError("opencode", "configuration", "OpenCode sessions require one selected account; different selected accounts need separate engines")
      }
    }
  }

  private async open(input: StartInput, broker: SessionBroker, upstream?: string): Promise<HarnessSession> {
    return this.bindingChanges.run("engine", () => this.openBound(input, broker, upstream))
  }

  private async openBound(input: StartInput, broker: SessionBroker, upstream?: string): Promise<HarnessSession> {
    this.assertOwner(input.owner)
    if (this.entries.has(input.sessionId)) throw new TransportError("opencode", "session", "OpenCode session is already attached")
    this.assertBindingCompatible(input)
    const scope = this.scope(input)
    const prior = this.documents.get(scope.directory)
    const priorDocument = await (await this.runtime.launch(scope)).read()
    const priorBinding = this.entries.values().next().value?.start.credentials
    let row: Awaited<ReturnType<OpenCodeRuntime["sessions"]["create"]>> | undefined
    let registered = false
    try {
      await this.runtime.bindProviders(providerOverlays(input.credentials))
      await this.applyProjection(input, scope)
      row = upstream ? await this.runtime.sessions.get(scope, upstream)
        : await this.runtime.sessions.create(scope, input.title ? { title: input.title } : {})
      if (upstream && row.id !== upstream) throw new TransportError("opencode", "session", "OpenCode attached a different session")
      const firstParty = this.services.firstPartyMcp(input.sessionId, input.locality)
      if (firstParty) {
        const registration = await firstPartyTools(firstParty, input.sessionId)
        await this.runtime.tools.registerSession({ scope, sessionID: row.id, ...registration })
        registered = true
      }
      const binding = await broker.rebind(row.id)
      this.owner = this.ownerKey(input.owner)
      const session: HarnessSession = { directory: scope.directory, locality: input.locality, binding }
      this.entries.set(input.sessionId, { session, start: input, broker, scope, upstream: row.id, active: false })
      return session
    } catch (error) {
      const failures = await rollbackOpenCodeSession({ runtime: this.runtime, scope, upstream, rowID: row?.id,
        registered, document: priorDocument, binding: priorBinding })
      if (prior) this.documents.set(scope.directory, prior)
      else this.documents.delete(scope.directory)
      if (failures.length) throw new TransportError("opencode", "session",
        `OpenCode open failed and rollback failed: ${failures.map((failure) => errorMessage(failure)).join("; ")}`, { cause: error })
      throw error
    }
  }

  start(input: StartInput, broker: SessionBroker): Promise<HarnessSession> { return this.open(input, broker) }
  attach(input: AttachInput, broker: SessionBroker): Promise<HarnessSession> {
    if (input.binding.sessionId !== input.sessionId || input.binding.workspaceId !== input.workspaceId) {
      throw new TransportError("opencode", "session", "OpenCode attachment binding does not match the session")
    }
    return this.open(input, broker, input.binding.upstreamSessionId)
  }

  async capabilities(context: { directory: string; sessionId?: string }) {
    const entry = context.sessionId ? this.entries.get(context.sessionId) : undefined
    const scope = entry?.scope ?? WorkspaceScope.authorize({ workspaceID: "opencode-catalog", directory: context.directory })
    return openCodeCapabilities(await this.runtime.catalog.models(scope))
  }

  send(session: HarnessSession, turn: TurnInput, broker: TurnBroker) {
    const entry = this.entry(session)
    return runOpenCodeTurn(this.runtime, entry, turn, broker)
  }

  async cancel(session: HarnessSession, _turn: TurnRef, deadline: Deadline) {
    const entry = this.entry(session)
    const expected = entry.assistantMessageID
    let finish!: (state: "terminal" | "uncorrelated" | "deadline") => void
    const settled = new Promise<"terminal" | "uncorrelated" | "deadline">((resolve) => { finish = resolve })
    const unsubscribe = this.runtime.events.subscribe((event) => {
      if (eventSessionID(event) !== session.binding.upstreamSessionId || !terminal(event, session.binding.upstreamSessionId)) return
      const id = eventAssistantMessageID(event)
      if (!id || !expected) finish("uncorrelated")
      else if (id === expected) finish("terminal")
    })
    try {
      try { await this.runtime.sessions.interrupt(entry.scope, session.binding.upstreamSessionId) }
      catch (cause) {
        return { execution: "unknown" as const, cleanup: "unknown" as const,
          error: { code: "provider_unreachable" as const, message: `OpenCode refused the interrupt: ${errorMessage(cause)}` } }
      }
      let state: "terminal" | "uncorrelated" | "deadline"
      try {
        state = await settleAtRequestDeadline("OpenCode interrupt", { deadlineAt: deadline.at, signal: deadline.signal },
          settled, unsubscribe, () => new TransportError("opencode", "engine", "OpenCode interrupt deadline expired"))
      } catch { state = "deadline" }
      return { execution: state === "terminal" ? "terminal" as const : state === "deadline" ? "running" as const : "unknown" as const,
        cleanup: "unknown" as const }
    } finally {
      unsubscribe()
    }
  }

  readonly steer = { steer: async (session: HarnessSession, _turn: TurnRef, input: TurnInput) => {
    const entry = this.entry(session)
    if (!entry.active) return { ok: false as const, status: "no_active_turn" as const,
      message: "OpenCode session has no active turn" }
    const admitted = await this.runtime.sessions.prompt(entry.scope, session.binding.upstreamSessionId, promptRequest(input))
    if (admitted.delivery === "steer" || admitted.delivery === "queue") return { ok: true as const }
    return { ok: false as const, status: "unknown" as const, message: "OpenCode did not confirm prompt admission" }
  } }

  async configure(session: HarnessSession, update: TransportConfigUpdate): Promise<ConfigApplied> {
    return this.bindingChanges.run("engine", () => this.configureBound(session, update))
  }

  private async configureBound(session: HarnessSession, update: TransportConfigUpdate): Promise<ConfigApplied> {
    const entry = this.entry(session)
    this.assertOwner(entry.start.owner)
    const next = mergeStartInput(entry.start, update)
    if (update.credentials) {
      this.assertBindingCompatible(next)
      await this.runtime.bindProviders(providerOverlays(update.credentials))
    }
    if (update.projection) await this.applyProjection(next, entry.scope)
    entry.start = next
    return { state: "applied" }
  }

  async close(session: HarnessSession): Promise<void> {
    const entry = this.entry(session)
    if (entry.active) throw new TransportError("opencode", "session", "OpenCode session has an active turn")
    await this.runtime.tools.unregisterSession(session.binding.upstreamSessionId)
    this.entries.delete(session.binding.sessionId)
    const document = this.documents.get(entry.scope.directory)
    document?.users.delete(session.binding.sessionId)
    if (document?.users.size === 0) this.documents.delete(entry.scope.directory)
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.runtime.close()
    this.entries.clear()
    this.documents.clear()
  }

  readonly naming = { rename: async (session: HarnessSession, title: string) => {
    const entry = this.entry(session)
    await this.runtime.sessions.rename(entry.scope, session.binding.upstreamSessionId, title)
  } }

  readonly fork = { fork: async (session: HarnessSession, messageId: string) => {
    const entry = this.entry(session)
    const row = await this.runtime.sessions.fork(entry.scope, session.binding.upstreamSessionId,
      { type: "before", messageID: messageId })
    return { upstreamSessionId: row.id }
  } }

  readonly commands = { list: async (target: ConfigTarget): Promise<readonly AgentCommand[]> => {
    const scope = this.targetScope(target)
    return (await this.runtime.catalog.commands(scope)).map((row) => ({ name: row.name,
      ...(row.description ? { description: row.description } : {}) }))
  } }

  readonly agents = { list: async (target: ConfigTarget): Promise<readonly AgentAgent[]> => {
    const scope = this.targetScope(target)
    return (await this.runtime.catalog.agents(scope)).map((row) => ({ name: row.name,
      ...(row.id ? { id: row.id } : {}), ...(row.description ? { description: row.description } : {}),
      ...(row.mode ? { mode: row.mode } : {}) }))
  } }

  private targetScope(target: ConfigTarget): WorkspaceScope {
    if ("session" in target) return this.entry(target.session).scope
    return this.scope(target.draft)
  }

  readonly config = {
    read: async (session: HarnessSession): Promise<SessionConfig> => this.entry(session).start.config,
    update: async (session: HarnessSession, update: SessionConfigUpdate): Promise<SessionConfig> => {
      const entry = this.entry(session)
      const previous = entry.start.config
      const next: SessionConfig = {
        ...previous,
        ...(update.harness !== undefined ? { harness: update.harness } : {}),
        ...(update.permissionCeiling !== undefined ? { permissionCeiling: update.permissionCeiling } : {}),
        ...(update.permissionMode !== undefined ? { permissionMode: update.permissionMode ?? undefined } : {}),
        ...(update.permissionState !== undefined ? { permissionState: update.permissionState ?? undefined } : {}),
        ...(update.model !== undefined ? { model: update.model ?? undefined } : {}),
        ...(update.variant !== undefined ? { variant: update.variant ?? undefined } : {}),
        ...(update.agent !== undefined ? { agent: update.agent ?? undefined } : {}),
        ...(update.instructions !== undefined ? { instructions: update.instructions ?? undefined } : {}),
        ...(update.group !== undefined ? { group: update.group ?? undefined } : {}),
        ...(update.handoff !== undefined ? { handoff: update.handoff ?? undefined } : {}),
      }
      entry.start = { ...entry.start, config: next }
      return next
    },
    options: async (target: ConfigPreviewTarget): Promise<ConfigOptionsPreview> => {
      const models = await this.runtime.catalog.models(this.targetScope(target))
      return configOptionsPreview([{ id: "model", name: "Model", selectOptions: models.map((model) =>
        ({ id: `${model.providerID}/${model.id}`, name: model.name ?? model.id })) }])
    },
    permissionModes: async () => ({ modes: [], unsupported: "OpenCode does not expose a session permission mode", appliesFrom: "next-turn" as const }),
    setPermissionMode: async () => { throw new TransportError("opencode", "configuration", "OpenCode does not expose a session permission mode") },
  }

  readonly health = {
    connection: (_directory: string, sessionId?: string) => sessionConnectionHealth(sessionId, (id) => this.entries.has(id), "configured"),
    runtime: () => {
      const status = this.runtime.host.status()
      return { status: status.lifecycle === "closed" || status.lifecycle === "unavailable" ? "unavailable" as const
        : status.events === "degraded" ? "degraded" as const : "ok" as const,
        ...(status.reason ? { reason: status.reason } : {}) }
    },
  }
}

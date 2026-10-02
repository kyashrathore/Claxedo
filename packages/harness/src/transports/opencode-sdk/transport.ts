import type { AgentAgent, AgentCommand } from "@claxedo/agent-runtime-contract"
import type { AttachInput, ConfigApplied, ConfigTarget, HarnessServices, HarnessSession,
  HarnessTransport, DraftLaunch, ScopedSessionTools, SessionBroker, SessionToolOperations, StartInput, TransportConfigUpdate, TurnBroker, TurnInput, TurnRef, Deadline } from "../../contract"
import { openCodeLaunchDocument } from "../../profiles/opencode/index.js"
import { openCodeCapabilities } from "./capabilities.js"
import { rollbackOpenCodeSession } from "./open-rollback.js"
import { engineProviderBinding } from "./credentials.js"
import { applyEngineProviders, engineProviderConfigurationKey, engineProviderDefinitions } from "./provider-configuration.js"
import { OpenCodeOwnerMismatchError } from "./errors.js"
import { TransportError } from "../../contract/errors.js"
import { firstPartyTools } from "./first-party-tools.js"
import { openCodeConfigOperations } from "./session-config.js"
import type { Entry } from "./entry.js"
import { cancelOpenCodeTurn } from "./cancel.js"
import { createOpenCodeRuntime, type OpenCodeRuntime, type OpenCodeRuntimeOptions } from "./runtime.js"

export type OpenCodeSdkTransportOptions = OpenCodeRuntimeOptions
import { WorkspaceScope } from "./scope.js"
import { promptRequest, runOpenCodeTurn } from "./turn.js"
import { createKeyedSerializer, errorMessage, singleFlightUntil } from "@claxedo/helpers"
import { attachedSessionEntry, mergeStartInput, sessionConnectionHealth, sessionMcpServers } from "../../contract"

export class OpenCodeSdkTransport implements HarnessTransport {
  readonly kind = "opencode-sdk" as const
  private readonly runtime: OpenCodeRuntime
  private readonly entries = new Map<string, Entry>()
  private readonly documents = new Map<string, { content: string; users: Set<string> }>()
  private readonly bindingChanges = createKeyedSerializer()
  private providerInput?: DraftLaunch
  private owner?: string
  private disposed = false
  private readonly closing = new AbortController()

  constructor(private readonly services: HarnessServices, options: OpenCodeSdkTransportOptions) {
    this.runtime = createOpenCodeRuntime(options)
  }

  private assertOwner(credentials: DraftLaunch["credentials"]): void {
    if (this.disposed) throw new TransportError("opencode", "engine", "OpenCode transport is disposed")
    if (this.owner !== undefined && this.owner !== credentials.accountOwner) throw new OpenCodeOwnerMismatchError()
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
    if (current?.content !== content) await (await this.runtime.launch(scope)).write(document)
    this.documents.set(scope.directory, { content, users: new Set([...(current?.users ?? []), input.sessionId]) })
  }

  private assertBindingCompatible(input: DraftLaunch & { sessionId?: string }): void {
    const selected = engineProviderConfigurationKey(input)
    for (const [id, entry] of this.entries) {
      if (id !== input.sessionId && engineProviderConfigurationKey(entry.start) !== selected) {
        throw new TransportError("opencode", "configuration", "OpenCode sessions require one selected account; different selected accounts need separate engines")
      }
    }
  }

  private async open(input: StartInput, broker: SessionBroker, upstream?: string): Promise<HarnessSession> {
    return this.bindingChanges.run("engine", () => this.openBound(input, broker, upstream))
  }

  private async openBound(input: StartInput, broker: SessionBroker, upstream?: string): Promise<HarnessSession> {
    this.assertOwner(input.credentials)
    if (this.entries.has(input.sessionId)) throw new TransportError("opencode", "session", "OpenCode session is already attached")
    this.assertBindingCompatible(input)
    const scope = this.scope(input)
    const prior = this.documents.get(scope.directory)
    const priorDocument = await (await this.runtime.launch(scope)).read()
    const priorStart = this.providerInput
    let row: Awaited<ReturnType<OpenCodeRuntime["sessions"]["create"]>> | undefined
    let registered = false
    try {
      await this.applyProviders(input)
      await this.applyProjection(input, scope)
      row = upstream ? await this.runtime.sessions.get(scope, upstream)
        : await this.runtime.sessions.create(scope, input.title ? { title: input.title } : {})
      if (upstream && row.id !== upstream) throw new TransportError("opencode", "session", "OpenCode attached a different session")
      const firstPartyTools_ = await this.registerFirstParty(input, scope, row.id)
      registered = firstPartyTools_ !== undefined
      const binding = await broker.rebind(row.id)
      this.owner = input.credentials.accountOwner
      const session: HarnessSession = { directory: scope.directory, locality: input.locality, binding }
      this.entries.set(input.sessionId, { session, start: input, broker, scope, upstream: row.id, active: false, steers: new Set(),
        ...(firstPartyTools_ ? { firstParty: firstPartyTools_ } : {}) })
      return session
    } catch (error) {
      const failures = await rollbackOpenCodeSession({ runtime: this.runtime, scope, upstream, rowID: row?.id,
        registered, document: priorDocument, priorDefinitions: priorStart ? engineProviderDefinitions(priorStart) : [],
        ...(priorStart ? { priorBinding: engineProviderBinding(priorStart) } : {}) })
      this.providerInput = priorStart
      if (prior) this.documents.set(scope.directory, prior)
      else this.documents.delete(scope.directory)
      if (failures.length) throw new TransportError("opencode", "session",
        `OpenCode open failed and rollback failed: ${failures.map((failure) => errorMessage(failure)).join("; ")}`, { cause: error })
      throw error
    }
  }

  private async registerFirstParty(input: StartInput, scope: WorkspaceScope, sessionID: string) {
    const server = this.services.firstPartyMcp(input.sessionId, input.locality)
    if (!server) return undefined
    const tools = await firstPartyTools(server, input.sessionId)
    await this.runtime.tools.registerSession({ scope, sessionID, ...tools })
    return tools
  }

  private async applyProviders(input: DraftLaunch): Promise<void> {
    if (this.providerInput && engineProviderConfigurationKey(input) === engineProviderConfigurationKey(this.providerInput)) return
    await applyEngineProviders(this.runtime, input, this.providerInput)
    this.providerInput = input
  }

  private readAsDraft<T>(draft: DraftLaunch, read: (scope: WorkspaceScope) => Promise<T>): Promise<T> {
    return this.bindingChanges.run("engine", async () => {
      this.assertOwner(draft.credentials)
      this.assertBindingCompatible(draft)
      await this.applyProviders(draft)
      return await read(this.scope(draft))
    })
  }

  readonly providerCatalog = { providers: (draft: DraftLaunch) => this.readAsDraft(draft, (scope) => this.runtime.catalog.providers(scope)) }

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
    return runOpenCodeTurn(this.runtime, entry, turn, broker, this.closing.signal)
  }

  async cancel(session: HarnessSession, _turn: TurnRef, deadline: Deadline) {
    return cancelOpenCodeTurn(this.runtime, this.entry(session), deadline)
  }

  readonly steer = { steer: async (session: HarnessSession, _turn: TurnRef, input: TurnInput) => {
    const entry = this.entry(session)
    if (!entry.active) return { ok: false as const, status: "no_active_turn" as const,
      message: "OpenCode session has no active turn" }
    entry.steers.add(input.userMessageId)
    const admitted = await this.runtime.sessions.prompt(entry.scope, session.binding.upstreamSessionId,
      { ...promptRequest(input), id: input.userMessageId })
    if (admitted.delivery === "steer" || admitted.delivery === "queue") return { ok: true as const }
    return { ok: false as const, status: "unknown" as const, message: "OpenCode did not confirm prompt admission" }
  } }

  async configure(session: HarnessSession, update: TransportConfigUpdate): Promise<ConfigApplied> {
    return this.bindingChanges.run("engine", () => this.configureBound(session, update))
  }

  private async configureBound(session: HarnessSession, update: TransportConfigUpdate): Promise<ConfigApplied> {
    const entry = this.entry(session)
    this.assertOwner(entry.start.credentials)
    const next = mergeStartInput(entry.start, update)
    if (update.credentials || update.providerDefinitions) {
      await this.applyProviders(next)
      for (const other of this.entries.values()) other.start = mergeStartInput(other.start, {
        credentials: next.credentials, providerDefinitions: next.providerDefinitions,
      })
    }
    if (update.projection) {
      await this.applyProjection(next, entry.scope)
      for (const other of this.entries.values()) {
        if (other.scope.directory === entry.scope.directory) other.start = { ...other.start, projection: update.projection }
      }
    }
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

  private readonly retire = singleFlightUntil(async () => {
    await this.runtime.close()
    this.entries.clear()
    this.documents.clear()
  }, () => true)

  async dispose(): Promise<void> {
    this.disposed = true
    this.closing.abort()
    await this.retire()
  }

  private async registerTools(entry: Entry): Promise<void> {
    const groups = [entry.firstParty, entry.scoped].filter((group): group is ScopedSessionTools => group !== undefined)
    if (!groups.length) { await this.runtime.tools.unregisterSession(entry.upstream); return }
    await this.runtime.tools.registerSession({
      scope: entry.scope, sessionID: entry.upstream,
      tools: groups.flatMap((group) => group.tools),
      execute: (call) => {
        const group = groups.find((candidate) => candidate.tools.some((tool) => tool.name === call.name))
        if (!group) throw new TransportError("opencode", "configuration", `OpenCode Session tool ${call.name} is unregistered`)
        return group.execute(call)
      },
    })
  }

  readonly sessionTools: SessionToolOperations = {
    register: async (session: HarnessSession, scoped: ScopedSessionTools): Promise<void> => {
      const entry = this.entry(session)
      entry.scoped = scoped
      await this.registerTools(entry)
    },
    unregister: async (session: HarnessSession): Promise<void> => {
      const entry = this.entry(session)
      if (!entry.scoped) return
      entry.scoped = undefined
      await this.registerTools(entry)
    },
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

  readonly config = openCodeConfigOperations({
    entry: (session) => this.entry(session),
    targetScope: (target) => this.targetScope(target),
    models: (scope, target) => "draft" in target ? this.readAsDraft(target.draft, (draftScope) => this.runtime.catalog.models(draftScope))
      : this.runtime.catalog.models(scope),
    switchModel: (scope, upstream, model) => this.runtime.sessions.switchModel(scope, upstream, model),
  })

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

import os from "node:os"
import path from "node:path"
import { HARNESS_TABLE, type SessionTitleRequest } from "@claxedo/agent-runtime-contract"
import type {
  AttachInput, CapabilityContext, ConfigApplied, ConfigOptionsPreview, ConfigPreviewTarget, ConfigTarget, Deadline, DraftLaunch,
  HarnessServices, HarnessSession, HarnessTransport, MachineLoginPolicy, RoutedEvent, SessionBroker, StartInput, TransportCapabilities,
  TransportConfigUpdate, TurnBroker, TurnInput, TurnRef,
} from "../../contract"
import { attachedSessionEntry, configOptionsPreview, mergeStartInput, selectedTurnAccount } from "../../contract"
import { withTurnAccount } from "../../translate/turn-account"
import { TransportError } from "../../contract/errors"
import { composeCursorHome, cursorHomeKey } from "../../profiles/cursor"
import { cancelCursorTurn } from "./cancel"
import { cursorCredential, type CursorCredential } from "./credentials"
import { CursorEntryLifecycle, type CursorEntry as Entry } from "./entry"
import { CursorGoals } from "./goals"
import { CursorHostRegistry, type CursorWorker, type CursorHost, type CursorHostKey } from "./host-registry"
import { cursorModelId, hostSession } from "./launch"
import { CursorModelCatalog, catalogKey, cursorCatalogModels, cursorModelOptions } from "./models"
import { cursorPermissionModeState } from "./permission-modes"
import type { HostModel } from "./protocol"
import { steerCursorTurn } from "./steer"
import { cursorSessionTitle } from "./title"
import { cursorPrompt, streamCursorRun } from "./turn"

export { CURSOR_WORKER_FILE } from "./worker-file"

export type CursorSdkTransportOptions = MachineLoginPolicy & { homeRoot: string; worker: CursorWorker; env?: NodeJS.ProcessEnv }

function cursorCapabilities(models: readonly HostModel[] | undefined): TransportCapabilities {
  return {
    modelSelection: { status: "required", models: models ? cursorCatalogModels(models) : [] },
    effortLevels: { status: "unsupported", models: [] },
    instructionChannel: "prompt-prefix",
    requests: { permissions: false, questions: false, elicitation: false },
    subagents: true,
    goals: { implemented: true, available: true, actions: [], recovery: "blocked", optionalFields: ["lastReason"] },
    todos: true, history: "store",
  }
}

function hostKey(credential: CursorCredential, home: string): CursorHostKey {
  return { binding: credential.key, home, ...(credential.backendUrl ? { backendUrl: credential.backendUrl } : {}) }
}

export class CursorSdkTransport implements HarnessTransport {
  readonly kind = "cursor-sdk" as const
  private readonly env: NodeJS.ProcessEnv
  private readonly registry: CursorHostRegistry
  private readonly entries = new Map<string, Entry>()
  private readonly lifecycle = new CursorEntryLifecycle()
  private readonly catalog = new CursorModelCatalog()
  private readonly goalRuntime = new CursorGoals()
  private readonly disposeAbort = new AbortController()

  constructor(private readonly services: HarnessServices, private readonly options: CursorSdkTransportOptions) {
    this.env = options.env ?? process.env
    this.registry = new CursorHostRegistry(services, options.worker, this.env, this.disposeAbort.signal)
  }

  async capabilities(context: CapabilityContext): Promise<TransportCapabilities> {
    const entry = context.sessionId ? this.entries.get(context.sessionId) : undefined
    return cursorCapabilities(entry ? this.catalog.peek(catalogKey(entry.credential, entry.input.credentials.leaseGeneration)) : undefined)
  }

  private async compose(input: StartInput | DraftLaunch, credential: CursorCredential, key: string) {
    await this.services.recordHomeUse(path.join(this.options.homeRoot, key))
    const personal = credential.ownerLogin ? path.join(this.env.HOME ?? os.homedir(), ".cursor") : undefined
    return composeCursorHome({ root: this.options.homeRoot, key, projection: input.projection, ...(personal ? { personalCursorDir: personal } : {}) })
  }

  private async admit(input: StartInput, broker: SessionBroker, resumed?: string): Promise<HarnessSession> {
    const credential = cursorCredential(input, this.env)
    const composed = await this.compose(input, credential, cursorHomeKey(input.credentials.accountOwner, credential.key, input.projection))
    const host = hostKey(credential, composed.home)
    const process = await this.registry.acquire(host)
    let session: HarnessSession
    try {
      let upstream = resumed
      if (upstream === undefined) {
        const reply = await process.call({ kind: "open", session: hostSession(input, this.services, credential.apiKey, composed.local) })
        upstream = reply.value?.agentId
        if (!upstream) throw new TransportError("cursor", "sdk", "Cursor did not return an agent id")
      }
      try { session = { directory: input.directory, locality: input.locality, binding: await broker.rebind(upstream) } }
      catch (error) {
        if (resumed === undefined) await process.call({ kind: "close", sessionId: input.sessionId })
        throw error
      }
    } catch (error) {
      await this.registry.release(host, process)
      throw error
    }
    this.entries.set(input.sessionId, { session, input, broker, credential, host, process, plugins: composed.local,
      busy: false, reopen: false, unsent: resumed === undefined, replace: false })
    return session
  }

  start(input: StartInput, broker: SessionBroker): Promise<HarnessSession> {
    return this.admit(input, broker)
  }

  attach(input: AttachInput, broker: SessionBroker): Promise<HarnessSession> {
    return this.admit(input, broker, input.binding.upstreamSessionId)
  }

  private entry(session: HarnessSession): Entry {
    const entry = attachedSessionEntry(this.entries, session, () => new TransportError("cursor", "session", "Cursor session is not attached"))
    this.lifecycle.assertOpen(entry)
    return entry
  }

  private async closeAgent(entry: Entry): Promise<void> {
    if (!entry.process.failed) await entry.process.call({ kind: "close", sessionId: entry.session.binding.sessionId })
    entry.reopen = false
    if (entry.unsent) entry.replace = true
  }

  private async replaceAgent(entry: Entry, host: CursorHost): Promise<void> {
    const reply = await host.call({ kind: "open", session: hostSession(entry.input, this.services, entry.credential.apiKey, entry.plugins) })
    const upstream = reply.value?.agentId
    if (!upstream) throw new TransportError("cursor", "sdk", "Cursor did not return an agent id")
    entry.session = { directory: entry.session.directory, locality: entry.session.locality, binding: await entry.broker.rebind(upstream) }
    entry.replace = false
  }

  private async *run(entry: Entry, broker: TurnBroker, prompt: Awaited<ReturnType<typeof cursorPrompt>>,
    turn?: Pick<TurnInput, "model" | "prompt">): AsyncIterable<RoutedEvent> {
    if (entry.busy) throw new TransportError("cursor", "session", "Cursor turn already active")
    entry.busy = true
    const running = Promise.withResolvers<void>()
    entry.running = running.promise
    try {
      const host = await this.lifecycle.current(entry, this.registry)
      if (entry.reopen) await this.closeAgent(entry)
      if (entry.replace) await this.replaceAgent(entry, host)
      if (broker.signal.aborted || entry.starting?.abort.signal.aborted) return
      if (entry.starting) entry.starting.launched = true
      entry.unsent = false
      yield* streamCursorRun({ host, broker, prompt, ...(turn?.prompt.agent === "plan" ? { mode: "plan" as const } : {}),
        session: hostSession(entry.input, this.services, entry.credential.apiKey, entry.plugins, entry.session.binding.upstreamSessionId, turn?.model?.modelID) })
    } finally {
      entry.busy = false
      running.resolve()
    }
  }

  async *send(session: HarnessSession, turn: TurnInput, broker: TurnBroker): AsyncIterable<RoutedEvent> {
    const entry = this.entry(session)
    if (entry.busy || entry.starting) throw new TransportError("cursor", "session", "Cursor turn already active")
    const starting = { turnId: turn.turnId, launched: false, abort: new AbortController() }
    entry.starting = starting
    try {
      if (broker.signal.aborted) return
      const prompt = await cursorPrompt(turn, entry.input.directory)
      yield* withTurnAccount(this.run(entry, broker, prompt, turn), selectedTurnAccount("cursor", entry.input.credentials, HARNESS_TABLE.cursor.providerIds))
    } finally {
      if (entry.starting === starting) entry.starting = undefined
    }
  }

  readonly goals = {
    read: async (session: HarnessSession) => this.entry(session).broker.goal.read(),
    start: async (session: HarnessSession, objective: string, broker: SessionBroker) => {
      const entry = this.entry(session)
      return this.goalRuntime.start(session, broker, objective, (turnBroker, _turn, prompt) => this.run(entry, turnBroker, prompt))
    },
    pause: async () => ({ ok: false as const, status: "unsupported" as const, message: "Cursor Goal cannot pause" }),
    resume: async () => ({ ok: false as const, status: "unsupported" as const, message: "Cursor Goal cannot resume" }),
    stop: async (session: HarnessSession) => this.goalRuntime.stop(session, this.entry(session).broker),
    delete: async (session: HarnessSession) => this.goalRuntime.delete(session, this.entry(session).broker),
  }

  private async modelOptions(target: ConfigPreviewTarget, mode: "probe" | "peek"): Promise<ConfigOptionsPreview> {
    const entry = "session" in target ? this.entry(target.session) : undefined
    const input: StartInput | DraftLaunch = "session" in target ? this.entry(target.session).input : target.draft
    const credential = entry ? entry.credential : cursorCredential(input, this.env)
    const key = catalogKey(credential, input.credentials.leaseGeneration)
    const requested = cursorModelId(("model" in target ? target.model?.modelID : undefined) ?? input.config.model?.modelID ?? input.model?.modelID)
    if (mode === "peek") return configOptionsPreview(cursorModelOptions(this.catalog.peek(key) ?? [], requested))
    if (entry) return configOptionsPreview(cursorModelOptions(await this.catalog.load(key, () => this.lifecycle.current(entry, this.registry), credential), requested))
    const composed = await this.compose(input, credential, `${cursorHomeKey(input.credentials.accountOwner, credential.key, input.projection)}-probe`)
    const probe = hostKey(credential, composed.home)
    let host: CursorHost | undefined
    try { return configOptionsPreview(cursorModelOptions(await this.catalog.load(key, async () => host = await this.registry.acquire(probe), credential), requested)) }
    finally { if (host) await this.registry.release(probe, host) }
  }

  readonly config = {
    options: (target: ConfigPreviewTarget, mode: "probe" | "peek") => this.modelOptions(target, mode),
    permissionModes: async (target: ConfigTarget) =>
      cursorPermissionModeState("session" in target ? this.entry(target.session).input.config : target.draft.config),
    setPermissionMode: async (session: HarnessSession, modeId: string) => {
      const entry = this.entry(session)
      return this.lifecycle.run(entry, async () => {
        const state = cursorPermissionModeState({ permissionMode: modeId })
        entry.input = { ...entry.input, config: { ...entry.input.config, permissionMode: modeId } }
        if (entry.busy) entry.reopen = true
        else await this.closeAgent(entry)
        return state
      })
    },
  }

  readonly naming = {
    generateTitle: async (session: HarnessSession, request: SessionTitleRequest) => {
      const entry = this.entry(session)
      return cursorSessionTitle({ host: await this.lifecycle.current(entry, this.registry), request, log: this.services.log,
        session: hostSession(entry.input, this.services, entry.credential.apiKey, entry.plugins) })
    },
  }

  readonly steer = {
    steer: async (session: HarnessSession, _turn: TurnRef, input: TurnInput) => {
      const entry = this.entry(session)
      return steerCursorTurn(entry, this.registry.existing(entry.host), input)
    },
  }

  async cancel(session: HarnessSession, turn: TurnRef, deadline: Deadline) {
    const entry = this.entry(session)
    return cancelCursorTurn(entry, turn, deadline, { goals: this.goalRuntime, host: this.registry.existing(entry.host) })
  }

  async configure(session: HarnessSession, update: TransportConfigUpdate): Promise<ConfigApplied> {
    const entry = this.entry(session)
    return this.lifecycle.run(entry, () => this.configureEntry(entry, update))
  }

  private async configureEntry(entry: Entry, update: TransportConfigUpdate): Promise<ConfigApplied> {
    if (entry.busy) return { state: "refused", reason: "Cursor turn active" }
    const input = mergeStartInput(entry.input, update)
    const credential = cursorCredential(input, this.env)
    await this.closeAgent(entry)
    const composed = await this.compose(input, credential, path.basename(entry.host.home))
    const host = hostKey(credential, composed.home)
    if (host.binding !== entry.host.binding) {
      const process = await this.lifecycle.acquire(entry, this.registry, host)
      await this.registry.release(entry.host, entry.process)
      entry.process = process
    }
    Object.assign(entry, { input, credential, host, plugins: composed.local })
    return { state: "applied" }
  }

  async close(session: HarnessSession): Promise<void> {
    const entry = this.entries.get(session.binding.sessionId)
    if (!entry) return
    return this.lifecycle.close(entry, async () => {
      await this.goalRuntime.interrupt(session.binding.sessionId)
      await this.closeAgent(entry)
      await this.registry.release(entry.host, entry.process)
      this.entries.delete(session.binding.sessionId)
    })
  }

  async dispose(): Promise<void> {
    this.disposeAbort.abort()
    for (const entry of this.entries.values()) await this.close(entry.session)
    await this.registry.dispose()
  }
}

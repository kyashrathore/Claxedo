import os from "node:os"
import path from "node:path"
import type { SessionConfigUpdate, SessionTitleRequest } from "@claxedo/agent-runtime-contract"
import { errorMessage } from "@claxedo/helpers"
import type {
  AttachInput, CapabilityContext, ConfigApplied, ConfigOptionsPreview, ConfigPreviewTarget, ConfigTarget, Deadline, DraftLaunch,
  HarnessServices, HarnessSession, HarnessTransport, RoutedEvent, SessionBroker, StartInput, TransportCapabilities, TransportConfigUpdate,
  TurnBroker, TurnInput, TurnRef,
} from "../../contract"
import { attachedSessionEntry, configOptionsPreview, mergeStartInput } from "../../contract"
import { TransportError } from "../../contract/errors"
import { composeCursorHome, cursorHomeKey, type CursorPluginOptions } from "../../profiles/cursor"
import type { MachineLoginPolicy } from "../../contract"
import { cursorCredential, type CursorCredential } from "./credentials"
import { CursorGoals } from "./goals"
import { CursorHostRegistry, type CursorHostKey } from "./host-registry"
import { cursorModelId, hostSession } from "./launch"
import { CursorModelCatalog, catalogKey, cursorCatalogModels, cursorModelOptions } from "./models"
import { cursorPermissionModeState } from "./permission-modes"
import type { HostModel } from "./protocol"
import { cursorSessionTitle } from "./title"
import { cursorPrompt, streamCursorRun } from "./turn"

export type CursorSdkTransportOptions = MachineLoginPolicy & { homeRoot: string; env?: NodeJS.ProcessEnv }

type Entry = {
  session: HarnessSession
  input: StartInput
  broker: SessionBroker
  credential: CursorCredential
  host: CursorHostKey
  plugins: CursorPluginOptions
  busy: boolean
  reopen: boolean
}

function cursorCapabilities(models: readonly HostModel[] | undefined): TransportCapabilities {
  return {
    modelSelection: { status: "required", models: models ? cursorCatalogModels(models) : [] },
    effortLevels: { status: "unsupported", models: [] },
    instructionChannel: "prompt-prefix", configOwner: "runtime",
    requests: { permissions: false, questions: false, elicitation: false },
    subagents: true,
    goals: { implemented: true, available: true, actions: [], recovery: "blocked", optionalFields: ["lastReason"] },
    todos: true, history: "store", titles: "side-request",
    pluginIntake: { mcp: "session", skills: "plugin-dir" }, mcpTransports: { stdio: true, http: true, sse: true },
    timing: { model: "next-turn", effort: "next-turn", permissionMode: "next-turn", credentials: "after-active-turns" },
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
  private readonly catalog = new CursorModelCatalog()
  private readonly goalRuntime = new CursorGoals()
  private readonly disposeAbort = new AbortController()

  constructor(private readonly services: HarnessServices, private readonly options: CursorSdkTransportOptions) {
    this.env = options.env ?? process.env
    this.registry = new CursorHostRegistry(services, this.env, this.disposeAbort.signal)
  }

  async capabilities(context: CapabilityContext): Promise<TransportCapabilities> {
    const entry = context.sessionId ? this.entries.get(context.sessionId) : undefined
    return cursorCapabilities(entry ? this.catalog.peek(catalogKey(entry.credential, entry.input.credentials.leaseGeneration)) : undefined)
  }

  private credential(input: StartInput | DraftLaunch): CursorCredential {
    return cursorCredential(input, this.env, this.options)
  }

  private compose(input: StartInput | DraftLaunch, credential: CursorCredential, key: string) {
    const personal = credential.ownerLogin ? path.join(this.env.HOME ?? os.homedir(), ".cursor") : undefined
    return composeCursorHome({ root: this.options.homeRoot, key, projection: input.projection, ...(personal ? { personalCursorDir: personal } : {}) })
  }

  private homeKey(input: StartInput | DraftLaunch, credential: CursorCredential): string {
    return cursorHomeKey(input.owner, this.options, credential.key, input.projection)
  }

  private async admit(input: StartInput, broker: SessionBroker, resumed?: string): Promise<HarnessSession> {
    const credential = this.credential(input)
    const composed = await this.compose(input, credential, this.homeKey(input, credential))
    const host = hostKey(credential, composed.home)
    const process = await this.registry.acquire(host)
    let session: HarnessSession
    try {
      let upstream = resumed
      if (upstream === undefined) {
        const reply = await process.call({ kind: "open", session: hostSession(input, this.services, credential.apiKey, composed.local) })
        upstream = reply.kind === "result" ? reply.value?.agentId : undefined
        if (!upstream) throw new TransportError("cursor", "sdk", "Cursor did not return an agent id")
      }
      try { session = { directory: input.directory, locality: input.locality, binding: await broker.rebind(upstream) } }
      catch (error) {
        if (resumed === undefined) await process.call({ kind: "close", sessionId: input.sessionId })
        throw error
      }
    } catch (error) {
      await this.registry.release(host)
      throw error
    }
    this.entries.set(input.sessionId, { session, input, broker, credential, host, plugins: composed.local, busy: false, reopen: false })
    return session
  }

  start(input: StartInput, broker: SessionBroker): Promise<HarnessSession> {
    return this.admit(input, broker)
  }

  attach(input: AttachInput, broker: SessionBroker): Promise<HarnessSession> {
    return this.admit(input, broker, input.binding.upstreamSessionId)
  }

  private entry(session: HarnessSession): Entry {
    return attachedSessionEntry(this.entries, session, () => new TransportError("cursor", "session", "Cursor session is not attached"))
  }

  private async closeAgent(entry: Entry): Promise<void> {
    await this.registry.existing(entry.host)?.call({ kind: "close", sessionId: entry.session.binding.sessionId })
    entry.reopen = false
  }

  private async *run(entry: Entry, broker: TurnBroker, prompt: Awaited<ReturnType<typeof cursorPrompt>>,
    turn?: Pick<TurnInput, "model" | "prompt">): AsyncIterable<RoutedEvent> {
    if (entry.busy) throw new TransportError("cursor", "session", "Cursor turn already active")
    entry.busy = true
    try {
      const host = await this.registry.current(entry.host)
      if (entry.reopen) await this.closeAgent(entry)
      yield* streamCursorRun({ host, broker, prompt, services: this.services, ...(turn?.prompt.agent === "plan" ? { mode: "plan" as const } : {}),
        session: hostSession(entry.input, this.services, entry.credential.apiKey, entry.plugins, entry.session.binding.upstreamSessionId, turn?.model?.modelID) })
    } finally {
      entry.busy = false
    }
  }

  async *send(session: HarnessSession, turn: TurnInput, broker: TurnBroker): AsyncIterable<RoutedEvent> {
    const entry = this.entry(session)
    if (entry.busy) throw new TransportError("cursor", "session", "Cursor turn already active")
    const prompt = await cursorPrompt(turn, entry.input.directory)
    yield* this.run(entry, broker, prompt, turn)
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
    const credential = entry ? entry.credential : this.credential(input)
    const key = catalogKey(credential, input.credentials.leaseGeneration)
    const requested = cursorModelId(("model" in target ? target.model?.modelID : undefined) ?? input.config.model?.modelID ?? input.model?.modelID)
    if (mode === "peek") return configOptionsPreview(cursorModelOptions(this.catalog.peek(key) ?? [], requested))
    if (entry) return configOptionsPreview(cursorModelOptions(await this.catalog.load(key, () => this.registry.current(entry.host), credential), requested))
    const composed = await this.compose(input, credential, `${this.homeKey(input, credential)}-probe`)
    const probe = hostKey(credential, composed.home)
    try { return configOptionsPreview(cursorModelOptions(await this.catalog.load(key, () => this.registry.acquire(probe), credential), requested)) }
    finally { await this.registry.replace(probe) }
  }

  readonly config = {
    read: async (session: HarnessSession) => this.entry(session).input.config,
    update: async (session: HarnessSession, update: SessionConfigUpdate) => {
      const entry = this.entry(session)
      const { permissionMode, model, permissionState, ...rest } = { ...entry.input.config, ...update }
      const config: StartInput["config"] = { ...rest,
        ...(permissionMode === null ? {} : { permissionMode }),
        ...(model === null ? {} : { model }),
        ...(permissionState === null ? {} : { permissionState }),
      }
      entry.input = { ...entry.input, config }
      return config
    },
    options: (target: ConfigPreviewTarget, mode: "probe" | "peek") => this.modelOptions(target, mode),
    permissionModes: async (target: ConfigTarget) =>
      cursorPermissionModeState("session" in target ? this.entry(target.session).input.config : target.draft.config),
    setPermissionMode: async (session: HarnessSession, modeId: string) => {
      const entry = this.entry(session)
      const state = cursorPermissionModeState({ permissionMode: modeId })
      entry.input = { ...entry.input, config: { ...entry.input.config, permissionMode: modeId } }
      if (entry.busy) entry.reopen = true
      else await this.closeAgent(entry)
      return state
    },
  }

  readonly naming = {
    generateTitle: async (session: HarnessSession, request: SessionTitleRequest) => {
      const entry = this.entry(session)
      return cursorSessionTitle({ host: await this.registry.current(entry.host), request, log: this.services.log,
        session: hostSession(entry.input, this.services, entry.credential.apiKey, entry.plugins) })
    },
  }

  async cancel(session: HarnessSession, turn: TurnRef, deadline: Deadline) {
    const entry = this.entry(session)
    if (this.goalRuntime.turnId(session.binding.sessionId) === turn.turnId) {
      const settlement = await this.goalRuntime.interrupt(session.binding.sessionId)
      if (settlement?.state === "cancelled") return { execution: "terminal" as const, cleanup: "unknown" as const }
      return { execution: "unknown" as const, cleanup: "unknown" as const,
        ...(settlement?.state === "failed" ? { error: { code: "internal_error" as const, message: settlement.error } } : {}) }
    }
    if (!entry.busy) return { execution: "terminal" as const, cleanup: "unknown" as const }
    try {
      const host = this.registry.existing(entry.host)
      if (!host) throw new TransportError("cursor", "worker", "Cursor SDK host unavailable during cancellation")
      await host.call({ kind: "cancel", sessionId: session.binding.sessionId }, undefined, deadline)
      return { execution: "unknown" as const, cleanup: "unknown" as const }
    } catch (error) {
      return { execution: "unknown" as const, cleanup: "unknown" as const,
        error: { code: "provider_unreachable" as const, message: errorMessage(error) } }
    }
  }

  async configure(session: HarnessSession, update: TransportConfigUpdate): Promise<ConfigApplied> {
    const entry = this.entry(session)
    if (entry.busy) return { state: "refused", reason: "Cursor turn active" }
    const input = mergeStartInput(entry.input, update)
    const credential = this.credential(input)
    await this.closeAgent(entry)
    const composed = await this.compose(input, credential, path.basename(entry.host.home))
    const host = hostKey(credential, composed.home)
    if (host.binding !== entry.host.binding) {
      await this.registry.acquire(host)
      await this.registry.release(entry.host)
    }
    Object.assign(entry, { input, credential, host, plugins: composed.local })
    return { state: "applied" }
  }

  async close(session: HarnessSession): Promise<void> {
    const entry = this.entries.get(session.binding.sessionId)
    if (!entry) return
    await this.goalRuntime.interrupt(session.binding.sessionId)
    this.entries.delete(session.binding.sessionId)
    await this.closeAgent(entry)
    await this.registry.release(entry.host)
  }

  async dispose(): Promise<void> {
    this.disposeAbort.abort()
    for (const entry of this.entries.values()) await this.close(entry.session)
    await this.registry.dispose()
  }
}

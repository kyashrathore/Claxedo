import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import type { PromptModel } from "@claxedo/agent-runtime-contract"
import type {
  AttachInput, ConfigApplied, ConfigTarget, Deadline, HarnessServices, HarnessSession, HarnessTransport,
  RoutedEvent, SessionBroker, StartInput, TransportCapabilities, TransportConfigUpdate, TurnBroker, TurnInput, TurnRef,
} from "../../contract"
import { piEnvironment, piProjectionArgs, preparePiProfile, selectPiProfile, type PiProfile, type PiProfileOptions } from "../../profiles/pi"
import { PiTransportError } from "./errors"
import { piEvents } from "./events"
import { EventQueue } from "./queue"
import { PiRpc, type PiMessage } from "./rpc"
import { answerPiDialog } from "./ui"

type Entry = {
  session: HarnessSession
  start: StartInput
  profile: PiProfile
  broker: SessionBroker
  rpc: PiRpc
  busy: boolean
  settled: boolean
}

export type PiRpcOptions = PiProfileOptions & { binary: string; runtime: string; args?: readonly string[]; env: NodeJS.ProcessEnv }

function piRpcModelSelection(model: PromptModel): { provider: string; modelId: string } {
  const slash = model.modelID.indexOf("/")
  if (model.providerID !== "pi" || slash < 1 || slash === model.modelID.length - 1) {
    throw new PiTransportError("configuration", "Pi requires a provider/model key")
  }
  return { provider: model.modelID.slice(0, slash), modelId: model.modelID.slice(slash + 1) }
}

function piRpcPromptBody(turn: TurnInput): { message: string; images?: { type: "image"; mimeType: string; data: string }[] } {
  const text = turn.prompt.parts.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n")
  const images = turn.prompt.parts.flatMap((part) => {
    if (part.type !== "file") return []
    const match = part.url.match(/^data:(image\/[^;]+);base64,(.+)$/s)
    if (!match || !match[1] || !match[2]) throw new PiTransportError("configuration", "Pi attachments require inline base64 images")
    return [{ type: "image" as const, mimeType: match[1], data: match[2] }]
  })
  return { message: [turn.system, text].filter(Boolean).join("\n\n"), ...(images.length ? { images } : {}) }
}

function deadline(clock: HarnessServices["clock"], ms = 15_000): Deadline {
  return { at: clock.now() + ms, signal: new AbortController().signal }
}

export class PiRpcTransport implements HarnessTransport {
  readonly kind = "pi-rpc" as const
  private readonly entries = new Map<string, Entry>()
  private disposed = false

  constructor(private readonly services: HarnessServices, private readonly options: PiRpcOptions) {}

  async capabilities(): Promise<TransportCapabilities> {
    return {
      modelSelection: { status: "required", models: [] }, effortLevels: { status: "unresolved", models: [] },
      instructionChannel: "prompt-prefix" as const, configOwner: "runtime" as const,
      requests: { permissions: false, questions: true, elicitation: false },
      steer: true, subagents: false, goals: { implemented: false, available: false, actions: [], recovery: "blocked", optionalFields: [] },
      fork: false, agents: false, commands: true, todos: false, history: "store" as const,
      titles: "harness" as const,
      pluginIntake: { mcp: "none" as const, skills: "skill-dirs" as const },
      mcpTransports: { stdio: false, http: false, sse: false },
      timing: { model: "immediate" as const, effort: "immediate" as const, permissionMode: "immediate" as const, credentials: "after-active-turns" as const },
    }
  }

  private async launch(input: StartInput, profile: PiProfile, broker?: SessionBroker, resume?: string,
    role: "harness" | "probe" = "harness"): Promise<PiRpc> {
    if (this.disposed) throw new PiTransportError("process", "Pi transport disposed")
    await preparePiProfile(profile, input.model)
    const args = ["--mode", "rpc", "--session-dir", profile.sessionDir, ...piProjectionArgs(input.projection), ...this.options.args ?? []]
    if (resume) args.push("--session", resume)
    const binary = this.options.binary
    const command = /\.[cm]?js$/.test(binary) ? { file: this.options.runtime, args: [binary, ...args] } : { file: binary, args }
    const owned = await this.services.spawn({ ...command, cwd: input.directory,
      env: piEnvironment(profile, this.options.env) },
    { role, label: "Pi RPC", sessionId: input.sessionId })
    const rpc = new PiRpc(owned, this.services.clock, (event) => {
      if (broker) void broker.publish(event).catch((error: unknown) =>
        this.services.log.error("Pi RPC diagnostic publication failed", { error: String(error) }))
      else this.services.log.warn(event.diagnostic.message, { code: event.diagnostic.code, raw: event.diagnostic.raw })
    })
    try { await rpc.request("get_state"); return rpc }
    catch (error) { await rpc.retire(deadline(this.services.clock)); throw error }
  }

  private async remember(input: StartInput, profile: PiProfile, rpc: PiRpc, broker: SessionBroker): Promise<HarnessSession> {
    const state = await rpc.request("get_state")
    if (!state || typeof state !== "object" || !("sessionId" in state) || typeof state.sessionId !== "string") {
      await rpc.retire(deadline(this.services.clock))
      throw new PiTransportError("protocol", "Pi did not return a session id")
    }
    const binding = { sessionId: input.sessionId, workspaceId: input.workspaceId, directory: input.directory,
      connectionId: "pi-rpc", upstreamSessionId: state.sessionId }
    const session = { binding, directory: input.directory, locality: input.locality }
    this.entries.set(input.sessionId, { session, start: input, profile, broker, rpc, busy: false, settled: true })
    return session
  }

  private async sessionFile(profile: PiProfile, upstreamSessionId: string): Promise<string> {
    const files = await fs.readdir(profile.sessionDir)
    const file = files.find((name) => name.endsWith(`_${upstreamSessionId}.jsonl`))
    if (!file) throw new PiTransportError("session", "Pi session file is missing")
    return path.join(profile.sessionDir, file)
  }

  async start(input: StartInput, broker: SessionBroker): Promise<HarnessSession> {
    const profile = selectPiProfile(input.owner, input.credentials, input.directory, input.sessionId, this.options)
    const rpc = await this.launch(input, profile, broker)
    const session = await this.remember(input, profile, rpc, broker)
    try { await broker.rebind(session.binding.upstreamSessionId) }
    catch (error) {
      this.entries.delete(input.sessionId)
      await rpc.retire(deadline(this.services.clock))
      throw error
    }
    return session
  }

  async attach(input: AttachInput, broker: SessionBroker): Promise<HarnessSession> {
    const profile = selectPiProfile(input.owner, input.credentials, input.directory, input.sessionId, this.options)
    const rpc = await this.launch(input, profile, broker, await this.sessionFile(profile, input.binding.upstreamSessionId))
    const session = await this.remember(input, profile, rpc, broker)
    if (session.binding.upstreamSessionId !== input.binding.upstreamSessionId) {
      this.entries.delete(input.sessionId)
      await rpc.retire(deadline(this.services.clock))
      throw new PiTransportError("session", "Pi resumed a different session")
    }
    try { await broker.rebind(session.binding.upstreamSessionId) }
    catch (error) {
      this.entries.delete(input.sessionId)
      await rpc.retire(deadline(this.services.clock))
      throw error
    }
    return session
  }

  private entry(session: HarnessSession): Entry {
    const entry = this.entries.get(session.binding.sessionId)
    if (!entry || entry.session.binding.upstreamSessionId !== session.binding.upstreamSessionId) {
      throw new PiTransportError("session", "Pi session is not attached")
    }
    return entry
  }

  private receiveTurn(entry: Entry, broker: TurnBroker, queue: EventQueue<RoutedEvent>, pending: Set<Promise<void>>): () => void {
    const translate = piEvents(entry.session.binding.sessionId)
    return entry.rpc.onEvent((message: PiMessage) => {
      try {
        for (const event of translate(message)) queue.push(event)
        if (message.type === "extension_ui_request") {
          const task = answerPiDialog(message, entry.rpc, broker, entry.session.binding.sessionId, this.services.clock.now())
          pending.add(task)
          void task.then(() => pending.delete(task), (error: unknown) => queue.fail(error))
        }
        if (message.type === "agent_settled") { entry.settled = true; queue.end() }
      } catch (error) { queue.fail(error) }
    })
  }

  async *send(session: HarnessSession, turn: TurnInput, broker: TurnBroker): AsyncIterable<RoutedEvent> {
    const entry = this.entry(session)
    if (entry.busy) throw new PiTransportError("session", "Pi turn already active")
    entry.busy = true
    entry.settled = false
    const queue = new EventQueue<RoutedEvent>()
    const pending = new Set<Promise<void>>()
    const remove = this.receiveTurn(entry, broker, queue, pending)
    const removeFailure = entry.rpc.onFailure((error) => queue.fail(error))
    const onAbort = () => { void this.cancel(session, { turnId: turn.turnId, assistantMessageId: turn.assistantMessageId }, deadline(this.services.clock)).then(
      (result) => { if (result.error) queue.fail(new PiTransportError("process", result.error.message)) },
      (error: unknown) => queue.fail(error),
    ) }
    broker.signal.addEventListener("abort", onAbort, { once: true })
    void entry.rpc.process.exited.then(() => queue.fail(new PiTransportError("process", "Pi exited during turn")))
    try {
      if (turn.model) await entry.rpc.request("set_model", piRpcModelSelection(turn.model))
      if (turn.effort) await entry.rpc.request("set_thinking_level", { level: turn.effort })
      if (broker.signal.aborted) onAbort()
      else await entry.rpc.request("prompt", piRpcPromptBody(turn))
      while (true) {
        const next = await queue.next()
        if (next.done) break
        yield next.value
      }
      await Promise.all(pending)
    } catch (error) {
      await entry.rpc.retire(deadline(this.services.clock))
      this.entries.delete(session.binding.sessionId)
      throw error
    } finally {
      remove()
      removeFailure()
      broker.signal.removeEventListener("abort", onAbort)
      entry.busy = false
    }
  }

  async cancel(session: HarnessSession, _turn: TurnRef, _deadline: Deadline) {
    const entry = this.entry(session)
    if (!entry.busy) return { execution: "terminal" as const, cleanup: "unknown" as const }
    try {
      await entry.rpc.request("clear_queue")
      await entry.rpc.request("abort")
      return { execution: entry.settled ? "terminal" as const : "unknown" as const, cleanup: "unknown" as const }
    } catch (error) {
      return { execution: "unknown" as const, cleanup: "owned" as const,
        error: { code: "provider_unreachable" as const, message: String(error) } }
    }
  }

  async configure(session: HarnessSession, update: TransportConfigUpdate): Promise<ConfigApplied> {
    const entry = this.entry(session)
    if (!update.credentials && !update.projection) return { state: "applied" }
    if (entry.busy) return { state: "refused", reason: "Cannot reconfigure Pi during an active turn" }
    const start = { ...entry.start,
      ...(update.credentials ? { credentials: update.credentials } : {}),
      ...(update.projection ? { projection: update.projection } : {}) }
    const profile = selectPiProfile(start.owner, start.credentials, start.directory, start.sessionId, this.options, entry.profile.kind)
    await preparePiProfile(profile, start.model)
    await entry.rpc.retire(deadline(this.services.clock))
    const rpc = await this.launch(start, profile, entry.broker, await this.sessionFile(profile, entry.session.binding.upstreamSessionId))
    const state = await rpc.request("get_state")
    if (!state || typeof state !== "object" || !("sessionId" in state) || state.sessionId !== entry.session.binding.upstreamSessionId) {
      await rpc.retire(deadline(this.services.clock))
      throw new PiTransportError("session", "Pi resumed a different session after credential change")
    }
    entry.rpc = rpc
    entry.profile = profile
    entry.start = start
    return { state: "applied" }
  }

  async close(session: HarnessSession): Promise<void> {
    const entry = this.entry(session)
    await entry.rpc.retire(deadline(this.services.clock))
    this.entries.delete(session.binding.sessionId)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await Promise.all([...this.entries.values()].map((entry) => entry.rpc.retire(deadline(this.services.clock))))
    this.entries.clear()
  }

  readonly steer = {
    steer: async (session: HarnessSession, _turn: TurnRef, input: TurnInput) => {
      const entry = this.entry(session)
      if (!entry.busy) return { ok: false as const, status: "no_active_turn" as const, message: "No Pi turn is active" }
      await entry.rpc.request("steer", piRpcPromptBody(input))
      return { ok: true as const }
    },
  }

  readonly commands = {
    list: async (target: ConfigTarget) => {
      if ("session" in target) return this.commandList(this.entry(target.session).rpc)
      const input: StartInput = { ...target.draft, sessionId: `probe-${randomUUID()}` }
      const profile = selectPiProfile(input.owner, input.credentials, input.directory, input.sessionId, this.options)
      const rpc = await this.launch(input, profile, undefined, undefined, "probe")
      try { return await this.commandList(rpc) }
      finally { await rpc.retire(deadline(this.services.clock)) }
    },
  }

  private async commandList(rpc: PiRpc) {
    const result = await rpc.request("get_commands")
    if (!result || typeof result !== "object" || !("commands" in result) || !Array.isArray(result.commands)) {
      throw new PiTransportError("protocol", "Pi returned an invalid command list")
    }
    return result.commands.map((value: unknown) => {
      if (!value || typeof value !== "object" || !("name" in value) || typeof value.name !== "string") {
        throw new PiTransportError("protocol", "Pi command has no name")
      }
      return { name: value.name, description: "description" in value && typeof value.description === "string" ? value.description : undefined }
    })
  }

  readonly naming = { rename: async (session: HarnessSession, title: string) => {
    await this.entry(session).rpc.request("set_session_name", { name: title })
  } }

  readonly health = {
    connection: (_directory: string, sessionId?: string) => ({ state: sessionId && !this.entries.has(sessionId) ? "disconnected" as const : "ready" as const, processes: [] }),
    runtime: (_directory: string, sessionId?: string) => {
      const entry = sessionId ? this.entries.get(sessionId) : [...this.entries.values()][0]
      return { status: !entry || entry.rpc.alive ? "ok" as const : "degraded" as const }
    },
  }
}

export function createPiRpcTransport(services: HarnessServices, options: PiRpcOptions): HarnessTransport {
  return new PiRpcTransport(services, options)
}

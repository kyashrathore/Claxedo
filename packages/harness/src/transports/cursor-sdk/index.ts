import { createAgentEventRuntime } from "@claxedo/agent-event-runtime"
import { cursorRuntimeMessage, cursorSdkAdapter } from "@claxedo/agent-event-runtime/harnesses/cursor"
import type { SDKUserMessage } from "@cursor/sdk"
import type {
  AttachInput, ConfigApplied, Deadline, HarnessBinding, HarnessServices, HarnessSession, HarnessTransport,
  RoutedEvent, SessionBroker, StartInput, TransportCapabilities, TransportConfigUpdate, TurnBroker, TurnInput, TurnRef,
} from "../../contract"
import { attachedSessionEntry, mergeStartInput, ownerMayUseMachineLogin, selectedProviderProjection, sessionMcpServers } from "../../contract"
import { assertCursorProjection, projectCursorMcpServers } from "../../profiles/cursor"
import { unrecognizedEvent } from "../../translate/unrecognized"
import { inlineDataUrl, flattenTurnPrompt } from "../../translate/prompt"
import { routedIngest } from "../../translate/ingest"
import { TransportError } from "../../contract/errors"
import type { WorkerReply, WorkerSession } from "./protocol"
import { AsyncPushQueue, errorMessage } from "@claxedo/helpers"
import { CursorWorkerRegistry } from "./worker-registry"

type Entry = { session: HarnessSession; input: StartInput; key: string; busy: boolean }

function cursorCredential(input: StartInput, env: NodeJS.ProcessEnv) {
  const projection = selectedProviderProjection(input.credentials, ["cursor-sdk", "cursor"])
  if (projection && "unavailable" in projection) throw new TransportError("cursor", "configuration", `Cursor account unavailable: ${projection.reason}`)
  const ownerLogin = input.owner.kind === "machine-owner" && ownerMayUseMachineLogin(input.owner, {
    placement: input.locality === "local" ? "loopback" : "cloud", machineOwnerUserId: "", canUseOwnLogin: true,
  })
  const apiKey = projection?.placeholder ?? (ownerLogin ? env.CURSOR_API_KEY?.trim() : undefined)
  if (!apiKey) throw new TransportError("cursor", "configuration", "Cursor SDK requires an API key")
  return { apiKey, backendUrl: projection?.baseUrl, key: projection?.baseUrl ?? `owner:${env.CURSOR_BACKEND_URL ?? "default"}` }
}

function workerSession(input: StartInput, services: HarnessServices, env: NodeJS.ProcessEnv, agentId?: string): WorkerSession {
  const { apiKey } = cursorCredential(input, env)
  const servers = sessionMcpServers(input, services, { includeFirstParty: input.locality === "local",
    duplicate: (name) => new Error(`Duplicate Cursor MCP server ${name}`) })
  return {
    sessionId: input.sessionId, agentId, directory: input.directory, apiKey,
    model: input.model?.modelID && input.model.modelID !== "default" ? input.model.modelID : "auto",
    mcpServers: projectCursorMcpServers(servers),
  }
}

function inlineCursorPrompt(turn: TurnInput): string | SDKUserMessage {
  const text = flattenTurnPrompt(turn, { separator: "\n\n", system: "prefix" })
  const images = turn.prompt.parts.flatMap((part) => {
    if (part.type !== "file") return []
    const image = inlineDataUrl(part.url, { imageOnly: true, strictBase64: false })
    if (!image) throw new TransportError("cursor", "configuration", "Cursor requires inline image attachments")
    return [image]
  })
  return images.length ? { text, images } : text
}

function cursorRunResultEvents(runtime: ReturnType<typeof createAgentEventRuntime>, reply: WorkerReply): RoutedEvent[] {
  if (reply.kind !== "result") return []
  const value = reply.value
  if (!value?.runId || !value.agentId || !value.status) throw new TransportError("cursor", "sdk", "Cursor omitted its run result")
  const status = value.status
  if (status !== "finished" && status !== "cancelled" && status !== "error") {
    throw new TransportError("cursor", "sdk", `Cursor reported unknown run status ${status}`)
  }
  return routedIngest(runtime, { source: "cursor.local-run-stream", method: "result",
    payload: { type: "result", agentId: value.agentId, runId: value.runId, status,
      ...(value.result ? { result: value.result } : {}) } }, { method: "cursor.result" })
}

function translateReply(runtime: ReturnType<typeof createAgentEventRuntime>, reply: WorkerReply): RoutedEvent[] {
  if (reply.kind !== "event") return cursorRunResultEvents(runtime, reply)
  return routedIngest(runtime, { source: "cursor.sdk.message", method: `cursor/${reply.message.type}`,
    payload: cursorRuntimeMessage(reply.message) }, { method: `cursor.${reply.message.type}`,
    mapEvent: (event) => event.type === "diagnostic" && event.diagnostic.code.includes("unmapped")
      ? unrecognizedEvent("cursor.sdk", reply.message.type, reply.message) : event,
  })
}

export class CursorSdkTransport implements HarnessTransport {
  readonly kind = "cursor-sdk" as const
  private readonly registry: CursorWorkerRegistry
  private readonly entries = new Map<string, Entry>()

  constructor(private readonly services: HarnessServices, private readonly env: NodeJS.ProcessEnv = process.env) {
    this.registry = new CursorWorkerRegistry(env)
  }

  async capabilities(): Promise<TransportCapabilities> {
    return {
      modelSelection: { status: "required", models: [] }, effortLevels: { status: "unsupported", models: [] },
      instructionChannel: "prompt-prefix", configOwner: "runtime",
      requests: { permissions: false, questions: false, elicitation: false },
      subagents: false,
      goals: { implemented: false, available: false, actions: [], recovery: "blocked", optionalFields: [] },
      todos: false, history: "store", titles: "none",
      pluginIntake: { mcp: "session", skills: "none" }, mcpTransports: { stdio: true, http: true, sse: true },
      timing: { model: "next-turn", effort: "next-turn", permissionMode: "next-session", credentials: "after-active-turns" },
    }
  }

  async start(input: StartInput, broker: SessionBroker): Promise<HarnessSession> {
    assertCursorProjection(input.projection)
    const credential = cursorCredential(input, this.env)
    const worker = this.registry.acquire(credential.key, credential.backendUrl)
    let agentId: string | undefined
    try {
      const reply = await worker.call({ kind: "open", session: workerSession(input, this.services, this.env) })
      agentId = reply.kind === "result" ? reply.value?.agentId : undefined
      if (!agentId) throw new TransportError("cursor", "sdk", "Cursor did not return an agent id")
    } catch (error) {
      if (worker.failed) await this.registry.replace(credential.key)
      throw error
    }
    let binding: HarnessBinding
    try { binding = await broker.rebind(agentId) }
    catch (error) { await worker.call({ kind: "close", sessionId: input.sessionId }); throw error }
    const session: HarnessSession = { directory: input.directory, locality: input.locality, binding }
    this.entries.set(input.sessionId, { session, input, key: credential.key, busy: false })
    return session
  }

  async attach(input: AttachInput, broker: SessionBroker): Promise<HarnessSession> {
    assertCursorProjection(input.projection)
    const credential = cursorCredential(input, this.env)
    const session: HarnessSession = { directory: input.directory, locality: input.locality,
      binding: await broker.rebind(input.binding.upstreamSessionId) }
    this.entries.set(input.sessionId, { session, input, key: credential.key, busy: false })
    return session
  }

  private entry(session: HarnessSession): Entry {
    return attachedSessionEntry(this.entries, session, () => new TransportError("cursor", "session", "Cursor session is not attached"))
  }

  async *send(session: HarnessSession, turn: TurnInput, broker: TurnBroker): AsyncIterable<RoutedEvent> {
    const entry = this.entry(session)
    if (entry.busy) throw new TransportError("cursor", "session", "Cursor turn already active")
    entry.busy = true
    const credential = cursorCredential(entry.input, this.env)
    const worker = this.registry.acquire(entry.key, credential.backendUrl)
    const queue = new AsyncPushQueue<WorkerReply>()
    const runtime = createAgentEventRuntime({ harness: "cursor", threadId: session.binding.sessionId, adapter: cursorSdkAdapter() })
    const onAbort = () => { void worker.call({ kind: "cancel", sessionId: session.binding.sessionId }).then(
      () => {}, (error: unknown) => queue.fail(error)) }
    broker.signal.addEventListener("abort", onAbort, { once: true })
    try {
      const request = worker.call({ kind: "run", session: workerSession(entry.input, this.services, this.env, session.binding.upstreamSessionId),
        prompt: inlineCursorPrompt(turn), ...(turn.prompt.agent === "plan" ? { mode: "plan" } : {}) }, (reply) => queue.push(reply))
      void request.then((reply) => { queue.push(reply); queue.end() }, (error: unknown) => queue.fail(error))
      if (broker.signal.aborted) onAbort()
      while (true) {
        const next = await queue.next()
        if (next.done) break
        const reply = next.value
        for (const event of translateReply(runtime, reply)) yield event
        if (reply.kind === "result" && reply.value?.status === "error") {
          throw new TransportError("cursor", "sdk", "Cursor run failed")
        }
      }
    } catch (error) {
      if (worker.failed) await this.registry.replace(entry.key)
      throw error
    } finally {
      entry.busy = false
      broker.signal.removeEventListener("abort", onAbort)
    }
  }

  async cancel(session: HarnessSession, _turn: TurnRef, deadline: Deadline) {
    const entry = this.entry(session)
    if (!entry.busy) return { execution: "terminal" as const, cleanup: "unknown" as const }
    try {
      const worker = this.registry.existing(entry.key)
      if (!worker) throw new TransportError("cursor", "worker", "Cursor worker unavailable during cancellation")
      await worker.call({ kind: "cancel", sessionId: session.binding.sessionId }, undefined, deadline)
      return { execution: "unknown" as const, cleanup: "unknown" as const }
    } catch (error) {
      if (!this.registry.existing(entry.key)) await this.registry.replace(entry.key)
      return { execution: "unknown" as const, cleanup: "unknown" as const,
        error: { code: "provider_unreachable" as const, message: errorMessage(error) } }
    }
  }

  async configure(session: HarnessSession, update: TransportConfigUpdate): Promise<ConfigApplied> {
    const entry = this.entry(session)
    if (entry.busy) return { state: "refused", reason: "Cursor turn active" }
    const input = mergeStartInput(entry.input, update)
    try { assertCursorProjection(input.projection) }
    catch (error) { return { state: "refused", reason: errorMessage(error) } }
    const credential = cursorCredential(input, this.env)
    await this.registry.existing(entry.key)?.call({ kind: "close", sessionId: session.binding.sessionId })
    entry.input = input
    entry.key = credential.key
    return { state: "applied" }
  }

  async close(session: HarnessSession): Promise<void> {
    const entry = this.entries.get(session.binding.sessionId)
    if (!entry) return
    this.entries.delete(session.binding.sessionId)
    await this.registry.existing(entry.key)?.call({ kind: "close", sessionId: session.binding.sessionId })
  }

  async dispose(): Promise<void> {
    this.entries.clear()
    await this.registry.dispose()
  }
}

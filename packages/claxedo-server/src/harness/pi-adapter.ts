import path from "path"
import {
  SessionManager,
  createAgentSession,
  type AgentSession,
  type ModelRegistry,
} from "@mariozechner/pi-coding-agent"
import type { AgentAdapter, PromptInput, SessionConfig, SessionConfigPatch } from "../../../workspace-runtime/src/adapters/index"
import type { CompatEvent } from "../../../workspace-runtime/src/compat-events"
import {
  buildAssistantMessage,
  buildUserMessage,
  messageUpdated,
  sessionError,
  sessionStatus,
} from "../../../workspace-runtime/src/compat-events"
import type { CompatEnvelope } from "../../../workspace-runtime/src/compat-events"
import type { ChunkToEventContext } from "../../../workspace-runtime/src/adapters/translate-chunk-to-event"
import { translateChunkToEvent } from "../../../workspace-runtime/src/adapters/translate-chunk-to-event"
import { defaultRunner, listCommands, loadUserConfig } from "../agent-config"
import { dataDir } from "../paths"
import {
  deleteSessionRunner,
  getSessionConfig,
  setSessionConfig,
  updateSessionConfig as patchSessionConfig,
} from "../session-runner"
import type { Workspace } from "../workspace-store"
import type { ProjectionStore } from "../control-plane/projection-store"
import { createPiAuth, createPiAuthAsync, createPiRegistry, decodePiModel, encodePiModel, piModelOptions } from "./pi-support"

type Live = {
  session: AgentSession
  manager: SessionManager
}

function row(input: Awaited<ReturnType<ProjectionStore["session_meta"]>>) {
  if (!input) return null
  return {
    id: input.sessionID,
    title: input.title ?? null,
    directory: input.directory,
    ...(input.parentID ? { parentID: input.parentID } : {}),
    ...(input.rootID ? { rootID: input.rootID } : {}),
    ...(input.projectID ? { projectID: input.projectID } : {}),
    tags: input.tags,
    attachments: input.attachments,
    time: {
      created: input.createdAt,
      updated: input.updatedAt,
      ...(typeof input.archived === "number" ? { archived: input.archived } : {}),
    },
  }
}

function text(input: unknown) {
  return typeof input === "string" ? input : ""
}

function modelInfo(config: SessionConfig, input?: PromptInput["model"]) {
  if (config.model) return config.model
  if (input) return input
  const hit = decodePiModel(config.runner.model)
  if (hit) return hit
  return {
    providerID: "anthropic",
    modelID: "claude-sonnet-4-6",
  }
}

function promptText(parts: unknown[]) {
  const out = parts.flatMap((item) => {
    if (!item || typeof item !== "object") return []
    const row = item as Record<string, unknown>
    if (row.type === "text" && typeof row.text === "string") return [row.text]
    if (row.type === "resource") {
      const resource = row.resource
      if (resource && typeof resource === "object" && typeof (resource as Record<string, unknown>).text === "string") {
        return [(resource as Record<string, string>).text]
      }
    }
    return []
  })
  return out.join("\n\n").trim()
}

function delta(input: unknown) {
  if (!input || typeof input !== "object") return
  const row = input as Record<string, unknown>
  return text(row.delta) || text(row.text) || text(row.content)
}

function ctx(sessionId: string, directory: string, assistantMsgId: string): ChunkToEventContext {
  return {
    sessionId,
    directory,
    assistantMsgId,
    accumulatedText: "",
    accumulatedThinkingText: "",
    toolNamesByCallId: {},
    partIdMap: {},
    toolInputsByCallId: {},
    toolMetadataByCallId: {},
    toolStatusByCallId: {},
    textPartSeq: 0,
    reasoningPartSeq: 0,
    splitText: false,
    splitReasoning: false,
  }
}

function payloads(input: CompatEnvelope[]) {
  return input.map((item) => item.payload)
}

function missing(providerID: string, modelID: string) {
  return `No API key for ${providerID}/${modelID}`
}

export class PiAdapter implements AgentAdapter {
  private live = new Map<string, Live>()

  constructor(
    private ws: Workspace,
    private projectionStore: ProjectionStore,
  ) {}

  private root() {
    return path.join(dataDir(), "pi", this.ws.id, "sessions")
  }

  private async sessionConfig(id: string) {
    const saved = getSessionConfig(this.ws.id, id)
    if (saved) return saved
    const user = await loadUserConfig()
    const runner = defaultRunner(user)
    const model = runner.type === "pi" ? decodePiModel(runner.model) : undefined
    return {
      runner: {
        type: "pi",
        ...(runner.type === "pi" && runner.model ? { model: runner.model } : {}),
      },
      ...(model ? { model } : {}),
      variant: null,
      agent: null,
    } satisfies SessionConfig
  }

  private async model(reg: ModelRegistry, id: string) {
    const cfg = await this.sessionConfig(id)
    const hit = decodePiModel(cfg.runner.model) ?? cfg.model
    if (!hit) return
    return reg.find(hit.providerID, hit.modelID)
  }

  private async select(id: string, input?: PromptInput["model"]) {
    const cfg = await this.sessionConfig(id)
    const hit = cfg.model ?? input ?? decodePiModel(cfg.runner.model)
    if (!hit) return
    const user = await loadUserConfig()
    // Use async auth to resolve secrets from the credential registry
    const auth = await createPiAuthAsync(user)
    const reg = createPiRegistry(user)
    return {
      info: hit,
      auth: auth.hasAuth(hit.providerID),
      model: reg.find(hit.providerID, hit.modelID),
    }
  }

  private async open(id: string, directory: string) {
    const hit = this.live.get(id)
    if (hit) return hit
    const list = await SessionManager.list(directory, this.root())
    const file = list.find((item) => item.id === id)?.path
    if (!file) throw new Error(`Session ${id} not found`)
    const manager = SessionManager.open(file, this.root(), directory)
    const user = await loadUserConfig()
    const auth = await createPiAuthAsync(user)
    const reg = createPiRegistry(user)
    const model = await this.model(reg, id)
    const { session } = await createAgentSession({
      cwd: directory,
      sessionManager: manager,
      authStorage: auth,
      modelRegistry: reg,
      ...(model ? { model } : {}),
    })
    const live = { session, manager }
    this.live.set(id, live)
    return live
  }

  async listSessions(directory: string) {
    return (await this.projectionStore.list_session_metas({
      workspaceID: this.ws.id,
      directory,
    })).map(row).filter((item): item is Exclude<typeof item, null> => !!item)
  }

  async getSession(id: string) {
    return row(await this.projectionStore.session_meta(id))
  }

  async createSession(directory: string, title?: string) {
    const user = await loadUserConfig()
    const auth = await createPiAuthAsync(user)
    const reg = createPiRegistry(user)
    const runner = defaultRunner(user)
    const model = runner.type === "pi" && runner.model ? decodePiModel(runner.model) : undefined
    const manager = SessionManager.create(directory, this.root())
    const { session } = await createAgentSession({
      cwd: directory,
      sessionManager: manager,
      authStorage: auth,
      modelRegistry: reg,
      ...(model ? { model: reg.find(model.providerID, model.modelID) } : {}),
    })
    if (title) session.sessionManager.appendSessionInfo(title)
    this.live.set(session.sessionId, { session, manager })
    await this.projectionStore.put_session_meta(session.sessionId, {
      ws: this.ws,
      directory,
      title: title ?? null,
    })
    setSessionConfig(this.ws.id, session.sessionId, {
      runner: {
        type: "pi",
        ...(runner.type === "pi" && runner.model ? { model: runner.model } : {}),
      },
      ...(model ? { model } : {}),
      variant: null,
      agent: null,
    })
    return { id: session.sessionId }
  }

  async updateSession(id: string, input: { title?: string; time?: { archived?: number } }) {
    const hit = await this.projectionStore.session_meta(id)
    if (!hit) return null
    await this.projectionStore.put_session_meta(id, {
      ws: this.ws,
      directory: hit.directory,
      title: input.title ?? hit.title ?? null,
      parentID: hit.parentID ?? null,
      archived: input.time?.archived ?? hit.archived ?? null,
      tags: hit.tags,
      attachments: hit.attachments,
    })
    return row(await this.projectionStore.session_meta(id))
  }

  async getSessionConfig(id: string) {
    return this.sessionConfig(id)
  }

  async updateSessionConfig(id: string, patch: SessionConfigPatch) {
    const prev = await this.sessionConfig(id)
    if (patch.runner) {
      const same = prev.runner.type === patch.runner.type
        && (prev.runner.binary ?? "") === (patch.runner.binary ?? "")
      if (!same) throw new Error("Runner changes are only supported before a session is created")
    }
    const next = {
      runner: patch.runner ?? prev.runner,
      ...(patch.model === undefined
        ? prev.model
          ? { model: prev.model }
          : {}
        : patch.model
        ? { model: patch.model }
        : {}),
      variant: patch.variant === undefined ? prev.variant ?? null : patch.variant,
      agent: patch.agent === undefined ? prev.agent ?? null : patch.agent,
    } satisfies SessionConfig
    if (next.runner.type === "pi" && next.model) {
      next.runner = {
        ...next.runner,
        model: encodePiModel(next.model.providerID, next.model.modelID),
      }
    }
    patchSessionConfig(this.ws.id, id, next)
    const live = this.live.get(id)
    if (live && next.runner.type === "pi" && next.model) {
      const user = await loadUserConfig()
      const reg = createPiRegistry(user)
      const model = reg.find(next.model.providerID, next.model.modelID)
      if (model) await live.session.setModel(model)
    }
    return next
  }

  async deleteSession(id: string) {
    this.live.get(id)?.session.dispose()
    this.live.delete(id)
    await this.projectionStore.delete_session_meta(id)
    deleteSessionRunner(this.ws.id, id)
  }

  async *sendMessage(id: string, input: PromptInput, directory: string): AsyncIterable<CompatEvent> {
    const live = await this.open(id, directory)
    const selected = await this.select(id, input.model)
    const info = selected?.info ?? input.model ?? modelInfo(await this.sessionConfig(id), input.model)
    const context = ctx(id, directory, input.assistantMessageId)
    const start: CompatEvent[] = [
      sessionStatus(id, { type: "busy" }),
    ]
    if (input.userMessageId) {
      start.push(messageUpdated(buildUserMessage({
        id: input.userMessageId,
        sessionID: id,
        agent: input.agent,
        model: info,
        ...(input.tools ? { tools: input.tools } : {}),
        ...(input.format ? { format: input.format } : {}),
        ...(input.system ? { system: input.system } : {}),
        ...(input.variant ? { variant: input.variant } : {}),
      })))
    }
    start.push(messageUpdated(buildAssistantMessage({
      id: input.assistantMessageId,
      sessionID: id,
      parentID: input.userMessageId ?? id,
      agent: input.agent,
      model: info,
      directory,
    })))
    for (const event of start) yield event

    const queue: CompatEvent[] = []
    let done = false
    let wake: (() => void) | undefined
    const push = (events: CompatEvent[]) => {
      queue.push(...events)
      wake?.()
      wake = undefined
    }

    const off = live.session.subscribe((event) => {
      if (event.type === "message_update" && event.message.role === "assistant") {
        const hit = delta(event.assistantMessageEvent)
        if (!hit) return
        if ((event.assistantMessageEvent as { type?: unknown }).type === "thinking_delta") {
          context.accumulatedThinkingText += hit
          push(payloads(translateChunkToEvent({ type: "thinking-delta", delta: hit }, context)))
          return
        }
        context.accumulatedText += hit
        push(payloads(translateChunkToEvent({ type: "text-delta", delta: hit }, context)))
        return
      }
      if (event.type === "tool_execution_start") {
        push(payloads(translateChunkToEvent({ type: "tool-start", toolCallId: event.toolCallId, toolName: event.toolName }, context)))
        push(payloads(translateChunkToEvent({ type: "tool-input", toolCallId: event.toolCallId, input: event.args }, context)))
        return
      }
      if (event.type === "tool_execution_update") {
        push(payloads(translateChunkToEvent({ type: "tool-input", toolCallId: event.toolCallId, input: event.args }, context)))
        push(payloads(translateChunkToEvent({ type: "tool-output", toolCallId: event.toolCallId, output: event.partialResult }, context)))
        return
      }
      if (event.type === "tool_execution_end") {
        push(payloads(translateChunkToEvent(
          event.isError
            ? { type: "tool-error", toolCallId: event.toolCallId, error: text(event.result) || "Tool failed" }
            : { type: "tool-output", toolCallId: event.toolCallId, output: event.result },
          context,
        )))
      }
    })

    void (async () => {
      try {
        if (selected?.info && !selected.auth) {
          throw new Error(missing(selected.info.providerID, selected.info.modelID))
        }
        if (selected?.model) await live.session.setModel(selected.model)
        await live.session.prompt(promptText(input.parts))
        push(payloads(translateChunkToEvent({ type: "finish", sessionId: id }, context)))
      } catch (err) {
        push([sessionError(err instanceof Error ? err.message : String(err), id)])
      } finally {
        off()
        done = true
        wake?.()
      }
    })()

    while (!done || queue.length > 0) {
      const hit = queue.shift()
      if (hit) {
        yield hit
        continue
      }
      await new Promise<void>((resolve) => {
        wake = resolve
      })
    }
  }

  async getMessages(id: string) {
    return this.projectionStore.read_session_messages(id)
  }

  async abort(id: string): Promise<{ ok: true; status: "cancelled" | "already_idle" }> {
    const entry = this.live.get(id)
    if (!entry) return { ok: true, status: "already_idle" }
    await entry.session.abort()
    return { ok: true, status: "cancelled" }
  }

  async revert() {}

  async unrevert() {}

  async forkSession(_id: string, _messageId: string, _directory: string): Promise<{ id: string }> {
    throw new Error("Fork is not yet supported for pi sessions")
  }

  async executeCommand() {}

  async listCommands() {
    return listCommands()
  }

  async listAgents() {
    return [{
      name: "pi",
      description: "Pi (central harness)",
      mode: "primary",
    }]
  }

  async getTodos() {
    return []
  }

  async listPermissions() {
    return []
  }

  async respondPermission() {}

  async listQuestions() {
    return []
  }

  async replyQuestion() {}

  async rejectQuestion() {}

  async applyConfig() {}

  async probeConfigOptions() {
    return piModelOptions(await loadUserConfig())
  }

  dispose() {
    for (const live of this.live.values()) live.session.dispose()
    this.live.clear()
  }
}

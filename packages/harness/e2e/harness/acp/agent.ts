#!/usr/bin/env bun
import { randomUUID } from "node:crypto"
import { Readable, Writable } from "node:stream"
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type Agent,
  type CancelNotification,
  type ContentBlock,
  type InitializeResponse,
  type NewSessionResponse,
  type NewSessionRequest,
  type LoadSessionRequest,
  type ResumeSessionRequest,
  type ForkSessionRequest,
  type PromptRequest,
  type PromptResponse,
} from "@agentclientprotocol/sdk"
import { isTitlePrompt, lastMarker } from "../scripted-model-request"
import { ACP_RED_ENV, ACP_SCRIPT_DIR_ENV, lastAcpScriptName, readAcpScript, type AcpScript } from "./script"
import { playScript } from "./turn"
import { recordAcpRequest } from "./requests"

const red = process.env[ACP_RED_ENV] === "1"

function promptText(prompt: ContentBlock[]) {
  return prompt
    .map((block) => {
      if (block.type === "text") return block.text
      if (block.type === "resource" && "text" in block.resource) return block.resource.text
      return ""
    })
    .join("\n")
}

function defaultScript(text: string): AcpScript {
  if (isTitlePrompt(text)) return { steps: [{ kind: "text", text: "Scripted session" }] }
  return { steps: [{ kind: "text", text: lastMarker(text) ?? "ok" }] }
}

async function scriptFor(text: string, dir: string): Promise<AcpScript> {
  const name = lastAcpScriptName(text)
  if (!name) return defaultScript(text)
  const script = await readAcpScript(dir, name)
  if (!script) throw RequestError.internalError(undefined, `No scripted ACP script named "${name}" in ${dir}`)
  return script
}

export class ScriptedAgent implements Agent {
  private readonly turns = new Map<string, AbortController>()

  constructor(private readonly connection: AgentSideConnection, private readonly dir: string, private readonly headers: Record<string, string> = {}, private readonly record = true,
    private readonly restoreMode: "load" | "resume" = "resume", private readonly startupQuestion = process.env.SCRIPTED_ACP_START_QUESTION === "1") {}

  initialize(): InitializeResponse {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { loadSession: true, sessionCapabilities: { fork: {}, ...(this.restoreMode === "resume" ? { resume: {} } : {}) }, promptCapabilities: { image: true, embeddedContext: true }, mcpCapabilities: { http: true, sse: true } },
      authMethods: [],
      _meta: { jetbrains: { air: { version: 1, capabilities: ["nativeSubagentSessions"] } } },
    }
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    if (this.record) await recordAcpRequest(this.dir, "session/new", params, this.headers)
    if (process.env.SCRIPTED_ACP_HANG_NEW === "1") await new Promise<never>(() => {})
    const sessionId = `scripted-${randomUUID()}`
    if (this.startupQuestion) await this.connection.unstable_createElicitation({ sessionId, mode: "form", message: "Startup question",
      requestedSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] } })
    queueMicrotask(() => {
      void this.connection.sessionUpdate({ sessionId, update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "scripted", description: "Run a named scripted reply" }] } })
    })
    return {
      sessionId,
      modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default", description: "Scripted replies" }] },
      configOptions: [{ id: "mode", name: "Agent", category: "mode", type: "select", currentValue: "default", options: [{ value: "default", name: "Default" }, { value: "review", name: "Review" }] }],
    }
  }

  async loadSession(params: LoadSessionRequest) {
    if (this.record) await recordAcpRequest(this.dir, "session/load", params, this.headers)
    if (params.sessionId.startsWith("missing-")) throw RequestError.resourceNotFound(params.sessionId)
    return {}
  }

  async resumeSession(params: ResumeSessionRequest) {
    if (this.record) await recordAcpRequest(this.dir, "session/resume", params, this.headers)
    if (params.sessionId.startsWith("missing-")) throw RequestError.resourceNotFound(params.sessionId)
    return {}
  }

  async unstable_forkSession(params: ForkSessionRequest) {
    if (this.record) await recordAcpRequest(this.dir, "session/fork", params, this.headers)
    return { sessionId: `scripted-${randomUUID()}` }
  }

  authenticate() {
    return {}
  }

  setSessionMode() {
    return {}
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    if (this.record) await recordAcpRequest(this.dir, "session/prompt", params, this.headers)
    const text = promptText(params.prompt)
    if (red && !isTitlePrompt(text)) throw RequestError.internalError(undefined, "Scripted ACP red run: every turn fails")
    const script = await scriptFor(text, this.dir)
    const controller = new AbortController()
    this.turns.get(params.sessionId)?.abort()
    this.turns.set(params.sessionId, controller)
    try {
      return await playScript({ connection: this.connection, sessionId: params.sessionId, scriptDir: this.dir, signal: controller.signal }, script)
    } finally {
      if (this.turns.get(params.sessionId) === controller) this.turns.delete(params.sessionId)
    }
  }

  cancel(params: CancelNotification) {
    this.turns.get(params.sessionId)?.abort()
  }
}

if (import.meta.main) {
  const scriptDir = process.env[ACP_SCRIPT_DIR_ENV]
  if (!scriptDir) throw new Error(`${ACP_SCRIPT_DIR_ENV} is not set`)
  const stream = ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
  )
  new AgentSideConnection((connection) => new ScriptedAgent(connection, scriptDir), stream)
}

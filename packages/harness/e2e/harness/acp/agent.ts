#!/usr/bin/env bun
import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
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
  type McpCapabilities,
  type NewSessionResponse,
  type NewSessionRequest,
  type LoadSessionRequest,
  type ResumeSessionRequest,
  type ForkSessionRequest,
  type PromptRequest,
  type PromptResponse,
  type SetSessionConfigOptionRequest,
} from "@agentclientprotocol/sdk"
import { isTitlePrompt, lastMarker } from "../scripted-model-request"
import { ACP_RED_ENV, ACP_SCRIPT_DIR_ENV, lastAcpScriptName, readAcpScript, recoveryContextDropped, type AcpScript } from "./script"
import { scriptedGoalExtension, scriptedGoals } from "./goals"
import { playScript } from "./turn"
import { recordAcpRequest } from "./requests"
import { captureAcpPrompt } from "./capture"
import { deliveredAcpPrompt } from "./delivery-fault"
import { knowsSession, rememberSession } from "./sessions"

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
  private readonly mcpUrls = new Map<string, { url: string; headers: Record<string, string> }>()
  private readonly goalRequest: ReturnType<typeof scriptedGoals>

  constructor(private readonly connection: AgentSideConnection, private readonly dir: string, private readonly headers: Record<string, string> = {}, private readonly record = true,
    private readonly restoreMode: "load" | "resume" = "resume", private readonly startupQuestion = process.env.SCRIPTED_ACP_START_QUESTION === "1",
    private readonly groups: readonly string[] = process.env.SCRIPTED_ACP_GROUPS?.split(",") ?? ["agents", "goals", "health"],
    private readonly mcpCapabilities: McpCapabilities = { http: true, sse: true }) {
    this.goalRequest = scriptedGoals(dir)
  }

  initialize(): InitializeResponse {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { loadSession: true, sessionCapabilities: { fork: {}, ...(this.restoreMode === "resume" ? { resume: {} } : {}) }, promptCapabilities: { image: true, embeddedContext: true }, mcpCapabilities: this.mcpCapabilities },
      authMethods: [],
      _meta: { jetbrains: { air: { version: 1, capabilities: ["nativeSubagentSessions"] } },
        ...(this.groups.includes("goals") ? { goal: scriptedGoalExtension } : {}),
        claxedo: { version: 1, health: this.groups.includes("health"), methods: [
          ...(this.groups.includes("steer") ? ["session/steer"] : []),
          ...(this.groups.includes("agents") ? ["session/agents/list"] : []),
        ] } },
    }
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    if (this.record) await recordAcpRequest(this.dir, "session/new", params, this.headers)
    if (process.env.SCRIPTED_ACP_HANG_NEW === "1") await new Promise<never>(() => {})
    const sessionId = `scripted-${randomUUID()}`
    rememberSession(this.dir, sessionId)
    const mcp = params.mcpServers.find((server) => server.name === "scripted" || server.name.endsWith("-scripted"))
    if (mcp && "url" in mcp && typeof mcp.url === "string") {
      const headers = Array.isArray(mcp.headers) ? mcp.headers : []
      this.mcpUrls.set(sessionId, { url: mcp.url, headers: Object.fromEntries(headers.map((header) => [header.name, header.value])) })
    }
    if (this.startupQuestion) {
      const answer = await this.connection.unstable_createElicitation({ sessionId, mode: "form", message: "Startup question",
        requestedSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] } })
      if (this.record) await recordAcpRequest(this.dir, "startup/answer", answer, this.headers)
    }
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
    if (!knowsSession(this.dir, params.sessionId)) throw RequestError.resourceNotFound(params.sessionId)
    return { modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default", description: "Scripted replies" }] } }
  }

  async resumeSession(params: ResumeSessionRequest) {
    if (this.record) await recordAcpRequest(this.dir, "session/resume", params, this.headers)
    if (!knowsSession(this.dir, params.sessionId)) throw RequestError.resourceNotFound(params.sessionId)
    return {}
  }

  async unstable_forkSession(params: ForkSessionRequest) {
    if (this.record) await recordAcpRequest(this.dir, "session/fork", params, this.headers)
    const sessionId = `scripted-${randomUUID()}`
    rememberSession(this.dir, sessionId)
    return { sessionId }
  }

  authenticate() {
    return {}
  }

  setSessionMode() {
    return {}
  }

  async setSessionConfigOption(params: SetSessionConfigOptionRequest) {
    if (this.record) await recordAcpRequest(this.dir, "session/set_config_option", params, this.headers)
    if (params.configId !== "mode" || typeof params.value !== "string") throw RequestError.invalidParams()
    return { configOptions: [{ id: "mode", name: "Agent", category: "mode" as const, type: "select" as const,
      currentValue: params.value, options: [{ value: "default", name: "Default" }, { value: "review", name: "Review" }] }] }
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    if (this.record) await recordAcpRequest(this.dir, "session/prompt", params, this.headers)
    const delivered = deliveredAcpPrompt(recoveryContextDropped(this.dir)
      ? params.prompt.filter((block) => block.type !== "text" || !block.text.includes("<session-context-recovery>"))
      : params.prompt, this.dir)
    const text = promptText(delivered)
    if (red && !isTitlePrompt(text)) throw RequestError.internalError(undefined, "Scripted ACP red run: every turn fails")
    const script = await scriptFor(text, this.dir)
    if (script.capturePrompt) {
      const name = lastAcpScriptName(text)
      if (!name) throw RequestError.internalError(undefined, "Prompt capture needs a named ACP script")
      await captureAcpPrompt(this.dir, name, delivered)
    }
    const controller = new AbortController()
    this.turns.get(params.sessionId)?.abort()
    this.turns.set(params.sessionId, controller)
    try {
      return await playScript({ connection: this.connection, sessionId: params.sessionId, scriptDir: this.dir, signal: controller.signal, prompt: text, mcp: this.mcpUrls.get(params.sessionId) }, script)
    } finally {
      if (this.turns.get(params.sessionId) === controller) this.turns.delete(params.sessionId)
    }
  }

  cancel(params: CancelNotification) {
    this.turns.get(params.sessionId)?.abort()
  }

  extMethod(method: string, params: Record<string, unknown>) {
    if (method === "session/steer" && this.groups.includes("steer")) return { ok: true }
    if (method === "session/agents/list" && this.groups.includes("agents")) return { agents: [
      { name: "default", description: "Default", mode: "primary" },
      { name: "review", description: "Review", mode: "primary" },
    ] }
    if (!this.groups.includes("goals")) throw RequestError.methodNotFound(method)
    return this.goalRequest(method, params)
  }
}

if (import.meta.main) {
  const scriptDir = process.env[ACP_SCRIPT_DIR_ENV]
  if (!scriptDir) throw new Error(`${ACP_SCRIPT_DIR_ENV} is not set`)
  if (process.env.SCRIPTED_ACP_RESISTANT_CHILD === "1") {
    const child = spawn("node", ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      { stdio: "ignore", detached: process.platform === "win32" })
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve())
      child.once("error", reject)
    })
    fs.writeFileSync(path.join(scriptDir, "writer.pid"), String(child.pid))
  }
  fs.writeFileSync(path.join(scriptDir, "agent.pid"), String(process.pid))
  const stream = ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
  )
  new AgentSideConnection((connection) => new ScriptedAgent(connection, scriptDir), stream)
}

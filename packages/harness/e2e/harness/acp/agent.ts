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
  type PromptRequest,
  type PromptResponse,
} from "@agentclientprotocol/sdk"
import { isTitlePrompt, lastMarker } from "../scripted-model-request"
import { ACP_RED_ENV, ACP_SCRIPT_DIR_ENV, lastAcpScriptName, readAcpScript, type AcpScript } from "./script"
import { scriptedGoalExtension, scriptedGoals } from "./goals"
import { playScript } from "./turn"

const scriptDir = process.env[ACP_SCRIPT_DIR_ENV]
if (!scriptDir) throw new Error(`${ACP_SCRIPT_DIR_ENV} is not set`)
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

class ScriptedAgent implements Agent {
  private readonly turns = new Map<string, AbortController>()
  private readonly goalRequest: ReturnType<typeof scriptedGoals>

  constructor(private readonly connection: AgentSideConnection, private readonly dir: string) {
    this.goalRequest = scriptedGoals(dir)
  }

  initialize(): InitializeResponse {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false, promptCapabilities: { image: true, embeddedContext: true } },
      authMethods: [],
      _meta: { jetbrains: { air: { version: 1, capabilities: ["nativeSubagentSessions"] } }, goal: scriptedGoalExtension },
    }
  }

  newSession(): NewSessionResponse {
    return {
      sessionId: `scripted-${randomUUID()}`,
      modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default", description: "Scripted replies" }] },
    }
  }

  authenticate() {
    return {}
  }

  setSessionMode() {
    return {}
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
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

  extMethod(method: string, params: Record<string, unknown>) {
    return this.goalRequest(method, params)
  }
}

const stream = ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
)
new AgentSideConnection((connection) => new ScriptedAgent(connection, scriptDir), stream)

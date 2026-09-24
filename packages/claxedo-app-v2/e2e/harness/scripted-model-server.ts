import { createServer, type Server, type ServerResponse } from "node:http"
import { respondChat, respondMessages, respondResponses, writeErrorReply, type ScriptedReply, type StreamPacing } from "./scripted-model-replies"
import {
  asRecord,
  dialectFor,
  hasToolResult,
  isAutoModeClassifier,
  isClaudeGoalEvaluatorPrompt,
  isGoalEvaluatorPrompt,
  isTitlePrompt,
  lastMarker,
  modelRequestBody,
  modelTools,
  promptText,
  readJson,
  type ScriptedDialect,
  type ScriptedModelBody,
  type ScriptedModelTool,
} from "./scripted-model-request"

export type { ScriptedDialect, ScriptedReply }

export type ScriptedModelRequest = {
  dialect: ScriptedDialect
  path: string
  body: ScriptedModelBody["body"]
  model: string
  prompt: string
  reply: ScriptedReply
  tools: ScriptedModelTool[]
}

export type ScriptedToolCall = { name: string; input: unknown; namespace?: string; whenPromptIncludes?: string; autoModeSeverity?: 0 }
export type ScriptedError = { marker: string; status: number; message: string; model?: string }

export type ScriptedModelServer = {
  url: string
  v1Url: string
  port: number
  requests: ScriptedModelRequest[]
  counts(): Record<ScriptedDialect, number>
  resetCounts(): void
  scriptTool(call: ScriptedToolCall): void
  scriptText(input: { marker: string; text: string }): void
  scriptError(input: ScriptedError): () => void
  holdTextReplies(marker: string): () => void
  setReplyDelayMs(ms: number): void
  setTextStreamPacing(pacing: StreamPacing | undefined): void
  close(): Promise<void>
}

type TextGate = { marker: string; promise: Promise<void>; release: () => void }

type ServerState = {
  counts: Record<ScriptedDialect, number>
  sequence: number
  goalEvaluations: number
  pendingTool?: ScriptedToolCall
  pendingText?: { marker: string; text: string }
  pendingError?: ScriptedError
  autoModeCommand?: string
  textGate?: TextGate
  replyDelayMs: number
  pacing?: StreamPacing
}

const SCRIPTED_TITLE = "Scripted Session"

function freshCounts(): Record<ScriptedDialect, number> {
  return { chat: 0, messages: 0, responses: 0 }
}

function goalReply(state: ServerState, prompt: string): ScriptedReply | undefined {
  if (isClaudeGoalEvaluatorPrompt(prompt)) {
    state.goalEvaluations += 1
    return state.goalEvaluations === 1
      ? { kind: "text", text: JSON.stringify({ ok: false, reason: "One more autonomous iteration is required" }) }
      : { kind: "text", text: JSON.stringify({ ok: true }) }
  }
  if (!isGoalEvaluatorPrompt(prompt)) return undefined
  state.goalEvaluations += 1
  return state.goalEvaluations === 1
    ? { kind: "text", text: JSON.stringify({ met: false, reason: "One more autonomous iteration is required" }) }
    : { kind: "text", text: JSON.stringify({ met: true, reason: "The scripted continuation supplied the required evidence" }) }
}

function pendingReply(state: ServerState, request: ScriptedModelBody, prompt: string): ScriptedReply | undefined {
  const tool = state.pendingTool
  if (tool && (tool.whenPromptIncludes ? prompt.includes(tool.whenPromptIncludes) : !hasToolResult(request))) {
    state.pendingTool = undefined
    return { kind: "tool", name: tool.name, input: tool.input, ...(tool.namespace ? { namespace: tool.namespace } : {}) }
  }
  const text = state.pendingText
  if (text && prompt.includes(text.marker)) {
    state.pendingText = undefined
    return { kind: "text", text: text.text }
  }
  return undefined
}

function decideReply(state: ServerState, request: ScriptedModelBody, prompt: string): ScriptedReply {
  const title = isTitlePrompt(JSON.stringify(request.body))
  const marker = lastMarker(prompt)
  const error = state.pendingError
  if (error && (!error.model || request.body.model === error.model) && prompt.includes(error.marker) && !title) {
    return { kind: "error", status: error.status, message: error.message }
  }
  if (isAutoModeClassifier(request, state.autoModeCommand)) return { kind: "text", text: "<severity>0</severity>" }
  if (title) return { kind: "text", text: marker ? `Session ${marker}` : SCRIPTED_TITLE }
  return goalReply(state, prompt) ?? pendingReply(state, request, prompt) ?? { kind: "text", text: marker ?? "ok" }
}

async function writeReply(outgoing: ServerResponse, state: ServerState, sequence: number, request: ScriptedModelBody, prompt: string, reply: ScriptedReply) {
  if (reply.kind === "error") return writeErrorReply(outgoing, reply)
  const gate = state.textGate
  if (reply.kind === "text" && gate && prompt.includes(gate.marker) && !isTitlePrompt(JSON.stringify(request.body))) await gate.promise
  if (state.replyDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.replyDelayMs))
  if (request.dialect === "chat") return respondChat(outgoing, sequence, reply, state.pacing)
  if (request.dialect === "responses") return respondResponses(outgoing, sequence, request.body, reply, state.pacing)
  return respondMessages(outgoing, sequence, request.body, reply, state.pacing)
}

function listen(server: Server, port: number) {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", resolve)
  })
}

function closeAll(server: Server) {
  return new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })
}

export async function startScriptedModelServer(input: { port: number }): Promise<ScriptedModelServer> {
  const requests: ScriptedModelRequest[] = []
  const state: ServerState = { counts: freshCounts(), sequence: 0, goalEvaluations: 0, replyDelayMs: 0 }
  const server = createServer(async (incoming, outgoing) => {
    if (incoming.method !== "POST") {
      outgoing.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }))
      return
    }
    const requestPath = incoming.url ?? "/"
    let request: ScriptedModelBody
    try {
      request = modelRequestBody(dialectFor(requestPath), await readJson(incoming))
    } catch (error) {
      outgoing.writeHead(400, { "content-type": "application/json" })
      outgoing.end(JSON.stringify({ error: `scripted model server could not read the request body: ${String(error)}` }))
      return
    }
    state.counts[request.dialect] += 1
    const sequence = ++state.sequence
    const prompt = promptText(request)
    const reply = decideReply(state, request, prompt)
    requests.push({ dialect: request.dialect, path: requestPath, body: request.body, model: request.body.model ?? "scripted", prompt, reply, tools: modelTools(request.body) })
    await writeReply(outgoing, state, sequence, request, prompt, reply)
  })
  await listen(server, input.port)
  const url = `http://127.0.0.1:${input.port}`
  return {
    url,
    v1Url: `${url}/v1`,
    port: input.port,
    requests,
    counts: () => ({ ...state.counts }),
    resetCounts: () => {
      state.counts = freshCounts()
      state.goalEvaluations = 0
      state.autoModeCommand = undefined
      requests.splice(0)
    },
    scriptError: (error) => {
      state.pendingError = error
      return () => {
        if (state.pendingError === error) state.pendingError = undefined
      }
    },
    scriptTool: (call) => {
      state.pendingTool = call
      const command = asRecord(call.input)?.command
      state.autoModeCommand = call.name === "Bash" && call.autoModeSeverity === 0 && typeof command === "string" ? command : undefined
    },
    scriptText: (text) => {
      if (state.pendingText) throw new Error("A scripted text reply is already pending")
      state.pendingText = text
    },
    holdTextReplies: (marker) => {
      if (state.textGate) throw new Error("A scripted text reply gate is already active")
      let release: () => void = () => {}
      const promise = new Promise<void>((resolve) => {
        release = resolve
      })
      const gate: TextGate = { marker, promise, release }
      state.textGate = gate
      return () => {
        gate.release()
        if (state.textGate === gate) state.textGate = undefined
      }
    },
    setReplyDelayMs: (ms) => {
      state.replyDelayMs = ms
    },
    setTextStreamPacing: (pacing) => {
      state.pacing = pacing
    },
    close: async () => {
      state.textGate?.release()
      await closeAll(server)
    },
  }
}

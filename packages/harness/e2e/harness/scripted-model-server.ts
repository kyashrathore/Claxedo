import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { sleep } from "@claxedo/helpers"
import { listenOnLoopback } from "./ports"
import { respondChat, respondMessages, respondResponses, writeErrorReply, type ScriptedReply, type ScriptedToolFormat, type StreamPacing } from "./scripted-model-replies"
import { asRecord } from "@claxedo/helpers/guards"
import {
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
  authorization?: string
  account?: string
  body: ScriptedModelBody["body"]
  model: string
  prompt: string
  reply: ScriptedReply
  tools: ScriptedModelTool[]
}

export type ScriptedToolCall = { name: string; input: unknown; namespace?: string; format?: ScriptedToolFormat; whenPromptIncludes?: string; autoModeSeverity?: 0
  /** Only a conversation's opening request, one with no tool result yet: a subagent's first request, not its parent's that carries its spawn. */
  opening?: true }
export type ScriptedError = { marker: string; status: number; message: string; model?: string; once?: true }

export type ScriptedModelServer = {
  url: string
  v1Url: string
  port: number
  requests: ScriptedModelRequest[]
  counts(): Record<ScriptedDialect, number>
  resetCounts(): void
  scriptTool(call: ScriptedToolCall): void
  scriptToolSequence(marker: string, calls: ScriptedToolCall[]): void
  scriptText(input: { marker: string; text: string; reasoning?: string }): void
  scriptError(input: ScriptedError): () => void
  holdTextReplies(marker: string): () => void
  holdOpeningReplies(marker: string): () => void
  textGateReached(marker: string): Promise<void>
  refuseAuthorization(fragment: string): void
  setReplyDelayMs(ms: number): void
  setTextStreamPacing(pacing: StreamPacing | undefined): void
  close(): Promise<void>
}

type TextGate = { marker: string; opening: boolean; promise: Promise<void>; release: () => void; reached: Promise<void>; arrive: () => void }

function gated(gate: TextGate | undefined, request: ScriptedModelBody, prompt: string, reply: ScriptedReply): gate is TextGate {
  if (!gate || !prompt.includes(gate.marker) || isTitlePrompt(JSON.stringify(request.body))) return false
  return gate.opening ? reply.kind !== "error" && !hasToolResult(request) : reply.kind === "text"
}

type ServerState = {
  counts: Record<ScriptedDialect, number>
  sequence: number
  goalEvaluations: number
  pendingTools: ScriptedToolCall[]
  pendingSequence?: { marker: string; calls: ScriptedToolCall[] }
  pendingText?: { marker: string; text: string; reasoning?: string }
  pendingError?: ScriptedError
  autoModeCommand?: string
  textGate?: TextGate
  replyDelayMs: number
  pacing?: StreamPacing
  refusedAuthorization?: string
}

const SCRIPTED_TITLE = "Scripted Session"

function holdReplies(state: ServerState, marker: string, opening: boolean): () => void {
  if (state.textGate) throw new Error("A scripted reply gate is already active")
  const { promise, resolve: release } = Promise.withResolvers<void>()
  const { promise: reached, resolve: arrive } = Promise.withResolvers<void>()
  const gate: TextGate = { marker, opening, promise, release, reached, arrive }
  state.textGate = gate
  return () => {
    gate.release()
    if (state.textGate === gate) state.textGate = undefined
  }
}

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

function toolReply(call: ScriptedToolCall): ScriptedReply {
  return { kind: "tool", name: call.name, input: call.input, ...(call.namespace ? { namespace: call.namespace } : {}), ...(call.format ? { format: call.format } : {}) }
}

function pendingReply(state: ServerState, request: ScriptedModelBody, prompt: string): ScriptedReply | undefined {
  const sequence = state.pendingSequence
  if (sequence && prompt.includes(sequence.marker) && sequence.calls.length) {
    const next = sequence.calls.shift()!
    if (!sequence.calls.length) state.pendingSequence = undefined
    return toolReply(next)
  }
  const tool = state.pendingTools[0]
  const opening = !hasToolResult(request)
  if (tool && modelTools(request.body).length && (tool.whenPromptIncludes ? prompt.includes(tool.whenPromptIncludes) && (opening || !tool.opening) : opening)) {
    state.pendingTools.shift()
    return toolReply(tool)
  }
  const text = state.pendingText
  if (text && prompt.includes(text.marker)) {
    state.pendingText = undefined
    return { kind: "text", text: text.text, ...(text.reasoning ? { reasoning: text.reasoning } : {}) }
  }
  return undefined
}

function decideReply(state: ServerState, request: ScriptedModelBody, prompt: string): ScriptedReply {
  const title = isTitlePrompt(JSON.stringify(request.body))
  const marker = lastMarker(prompt)
  const error = state.pendingError
  if (error && (!error.model || request.body.model === error.model) && prompt.includes(error.marker) && !title) {
    if (error.once) state.pendingError = undefined
    return { kind: "error", status: error.status, message: error.message }
  }
  if (isAutoModeClassifier(request, state.autoModeCommand)) return { kind: "text", text: "<severity>0</severity>" }
  if (title) return { kind: "text", text: marker ? `Session ${marker}` : SCRIPTED_TITLE }
  return goalReply(state, prompt) ?? pendingReply(state, request, prompt) ?? { kind: "text", text: marker ?? "ok" }
}

async function writeReply(outgoing: ServerResponse, state: ServerState, sequence: number, request: ScriptedModelBody, prompt: string, reply: ScriptedReply) {
  if (reply.kind === "error") return writeErrorReply(outgoing, reply)
  const gate = state.textGate
  if (gated(gate, request, prompt, reply)) {
    gate.arrive()
    await gate.promise
  }
  if (state.replyDelayMs > 0) await sleep(state.replyDelayMs)
  if (request.dialect === "chat") return respondChat(outgoing, sequence, reply, state.pacing)
  if (request.dialect === "responses") return respondResponses(outgoing, sequence, request.body, reply, state.pacing)
  return respondMessages(outgoing, sequence, request.body, reply, state.pacing)
}

function closeAll(server: Server) {
  return new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })
}

function chatgptBackend(incoming: IncomingMessage, outgoing: ServerResponse): boolean {
  const requestPath = incoming.url ?? "/"
  if (!requestPath.startsWith("/backend-api/") || requestPath.startsWith("/backend-api/codex/responses")) return false
  if (!requestPath.startsWith("/backend-api/wham/accounts/check")) {
    outgoing.writeHead(404).end()
    return true
  }
  const id = incoming.headers["chatgpt-account-id"]?.toString() ?? ""
  outgoing.writeHead(200, { "content-type": "application/json" })
  outgoing.end(JSON.stringify({ accounts: [{ id, workspace_backend_origin: "https://chatgpt.com", account_routing_override: "NO_CONSTRAINT" }] }))
  return true
}

export async function startScriptedModelServer(input: { port: number; red?: boolean }): Promise<ScriptedModelServer> {
  const requests: ScriptedModelRequest[] = []
  const state: ServerState = { counts: freshCounts(), sequence: 0, goalEvaluations: 0, replyDelayMs: 0, pendingTools: [] }
  const server = createServer(async (incoming, outgoing) => {
    if (chatgptBackend(incoming, outgoing)) return
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
    const authorization = incoming.headers.authorization ?? incoming.headers["x-api-key"]?.toString()
    const reply = state.refusedAuthorization && authorization?.includes(state.refusedAuthorization)
      ? { kind: "error" as const, status: 401, message: "Scripted model refused the renewed credential" }
      : input.red
      ? { kind: "error" as const, status: 503, message: "Scripted model red run: every turn fails" }
      : decideReply(state, request, prompt)
    const account = incoming.headers["chatgpt-account-id"]?.toString()
    requests.push({ dialect: request.dialect, path: requestPath, authorization, ...(account ? { account } : {}), body: request.body, model: request.body.model ?? "scripted", prompt, reply, tools: modelTools(request.body) })
    await writeReply(outgoing, state, sequence, request, prompt, reply)
  })
  await listenOnLoopback(server, input.port)
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
      if (process.env.CLAXEDO_E2E_MODEL_OMIT_TOOL === "1") return
      state.pendingTools.push(call)
      const command = asRecord(call.input)?.command
      state.autoModeCommand = call.name === "Bash" && call.autoModeSeverity === 0 && typeof command === "string" ? command : undefined
    },
    scriptToolSequence: (marker, calls) => {
      if (state.pendingSequence) throw new Error("A scripted tool sequence is already pending")
      state.pendingSequence = { marker, calls: [...calls] }
    },
    scriptText: (text) => {
      if (state.pendingText) throw new Error("A scripted text reply is already pending")
      state.pendingText = text
    },
    holdTextReplies: (marker) => holdReplies(state, marker, false),
    holdOpeningReplies: (marker) => holdReplies(state, marker, true),
    textGateReached: (marker) => {
      const gate = state.textGate
      if (!gate || gate.marker !== marker) throw new Error(`No scripted text reply gate is held for ${marker}`)
      return gate.reached
    },
    refuseAuthorization: (fragment) => {
      state.refusedAuthorization = fragment
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

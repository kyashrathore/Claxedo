import { asRecord, isNonEmptyString } from "@claxedo/helpers/guards"
import { isOperationUnavailable, toAppError } from "@/server"
import type { ConfirmOptions } from "@/ui"
import type { AppServerCalls } from "./api"
import { messageConfirm, toolCallConfirm, toolCallDecision, type AppReader, type ConsentText } from "./consent"
import { rpcResult, rpcError, RPC_INVALID_PARAMS, type JsonRpcParams, type RequestAnswer } from "./jsonrpc"

export type AppPromptSend = (text: string) => Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }>

export type AppRequestsInput = {
  readonly server: string
  readonly reader: () => AppReader
  readonly calls: AppServerCalls | undefined
  readonly sendPrompt: AppPromptSend | undefined
  readonly confirm: (options: ConfirmOptions) => Promise<boolean>
  readonly text: ConsentText
  readonly operationUnavailable: () => void
  readonly operationAnswered: () => void
}

export type AppRequests = {
  readonly callTool: (params: JsonRpcParams) => Promise<RequestAnswer>
  readonly readResource: (params: JsonRpcParams) => Promise<RequestAnswer>
  readonly message: (params: JsonRpcParams) => Promise<RequestAnswer>
}

type Attempt<T> = { readonly kind: "done"; readonly value: T } | { readonly kind: "failed"; readonly answer: RequestAnswer }

const UNAVAILABLE = "The app's server is unavailable; send a message in the session first"

export function appMessageText(params: JsonRpcParams): string | undefined {
  if (params.role !== "user" || !Array.isArray(params.content) || params.content.length === 0) return undefined
  const texts = params.content.map((block) => {
    const record = asRecord(block)
    return record?.type === "text" && typeof record.text === "string" ? record.text : undefined
  })
  if (texts.some((text) => text === undefined)) return undefined
  const text = texts.join("\n\n")
  return text.trim() ? text : undefined
}

function createAttempt(input: AppRequestsInput) {
  return async <T>(operation: string, run: () => Promise<T>): Promise<Attempt<T>> => {
    try {
      const value = await run()
      input.operationAnswered()
      return { kind: "done", value }
    } catch (error) {
      if (isOperationUnavailable(error)) {
        input.operationUnavailable()
        return { kind: "failed", answer: rpcError(UNAVAILABLE) }
      }
      const failure = toAppError(error)
      console.warn("mcp-apps: an app request failed", { server: input.server, operation, class: failure.class, error: failure })
      return { kind: "failed", answer: rpcError(failure.message) }
    }
  }
}

function createToolCall(input: AppRequestsInput, attempt: ReturnType<typeof createAttempt>) {
  return async (params: JsonRpcParams): Promise<RequestAnswer> => {
    const name = params.name
    const args = params.arguments === undefined ? {} : asRecord(params.arguments)
    if (!isNonEmptyString(name) || !args) return rpcError("tools/call needs a tool name and object arguments", RPC_INVALID_PARAMS)
    if (!input.reader().owner) return rpcError("Only the session's owner can run tools from an app")
    const calls = input.calls
    if (!calls) return rpcError(UNAVAILABLE)
    const listed = await attempt("tools/list", calls.tools)
    if (listed.kind === "failed") return listed.answer
    const decision = toolCallDecision(input.reader(), name, listed.value.find((tool) => tool.name === name))
    if (decision.kind === "refuse") return rpcError(decision.reason)
    if (decision.kind === "ask" && !(await input.confirm(toolCallConfirm(input.text, input.server, name, args)))) return rpcError("The reader declined the tool call")
    const called = await attempt("tools/call", () => calls.callTool(name, args))
    return called.kind === "done" ? rpcResult(called.value) : called.answer
  }
}

function createMessage(input: AppRequestsInput) {
  return async (params: JsonRpcParams): Promise<RequestAnswer> => {
    const text = appMessageText(params)
    if (text === undefined) return rpcError("ui/message takes text content from the user role only", RPC_INVALID_PARAMS)
    const sendPrompt = input.sendPrompt
    if (!sendPrompt || !input.reader().send) return rpcError("This reader cannot send messages to the session")
    if (!(await input.confirm(messageConfirm(input.text, text)))) return rpcError("The reader declined the message")
    const sent = await sendPrompt(text)
    return sent.ok ? rpcResult() : rpcError(sent.message)
  }
}

export function createAppRequests(input: AppRequestsInput): AppRequests {
  const attempt = createAttempt(input)
  return {
    callTool: createToolCall(input, attempt),
    readResource: async (params) => {
      const uri = params.uri
      if (!isNonEmptyString(uri)) return rpcError("resources/read needs a uri", RPC_INVALID_PARAMS)
      if (!input.reader().owner) return rpcError("Only the session's owner can read the app's server")
      const calls = input.calls
      if (!calls) return rpcError(UNAVAILABLE)
      const read = await attempt("resources/read", () => calls.readResource(uri))
      return read.kind === "done" ? rpcResult(read.value) : read.answer
    },
    message: createMessage(input),
  }
}

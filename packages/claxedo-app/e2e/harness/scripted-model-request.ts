import type { IncomingMessage } from "node:http"
import { asRecord } from "@claxedo/helpers/guards"
import type { MessageCreateParams } from "@anthropic-ai/sdk/resources/messages"
import type { ChatCompletionCreateParams } from "openai/resources/chat/completions"
import type { ResponseCreateParams } from "openai/resources/responses/responses"
import { SESSION_TITLE_SYSTEM_PROMPT } from "../../../agent-sdk-runtime/src/title-generation"

export type ScriptedDialect = "chat" | "messages" | "responses"

export type ScriptedModelBody =
  | { dialect: "chat"; body: ChatCompletionCreateParams }
  | { dialect: "messages"; body: MessageCreateParams }
  | { dialect: "responses"; body: ResponseCreateParams }

export type ScriptedModelTool = { name: string; inputSchema?: unknown }

export const MARKER_PROMPT = /reply with exactly this one token[^:]*:\s*\\?"?([A-Za-z0-9._-]+)/gi
const TITLE_INSTRUCTION = JSON.stringify(SESSION_TITLE_SYSTEM_PROMPT).slice(1, -1)
const GOAL_EVALUATOR_PROMPT = "You are an independent completion evaluator."
const CLAUDE_GOAL_EVALUATOR_PROMPT =
  "Based on the conversation transcript above, has the following stopping condition been satisfied?"

export function lastMarker(prompt: string): string | undefined {
  return [...prompt.matchAll(MARKER_PROMPT)].at(-1)?.[1]
}

export function isClaudeGoalEvaluatorPrompt(prompt: string) {
  return prompt.includes(CLAUDE_GOAL_EVALUATOR_PROMPT)
}

export function isGoalEvaluatorPrompt(prompt: string) {
  return prompt.includes(GOAL_EVALUATOR_PROMPT) || (prompt.includes("OBJECTIVE:") && prompt.includes("LATEST WORK RESULT:"))
}

export function isTitlePrompt(text: string) {
  return text.includes(TITLE_INSTRUCTION) || text.includes(SESSION_TITLE_SYSTEM_PROMPT)
}

export function dialectFor(path: string): ScriptedDialect {
  if (path.includes("responses")) return "responses"
  if (path.includes("messages")) return "messages"
  return "chat"
}

export function promptText(request: ScriptedModelBody) {
  const source = request.dialect === "responses" ? request.body.input : request.body.messages
  return JSON.stringify(source ?? request.body)
}

export function hasToolResult(request: ScriptedModelBody) {
  if (request.dialect === "responses") {
    return Array.isArray(request.body.input)
      && request.body.input.some((item) => ["function_call_output", "custom_tool_call_output"].includes(String(asRecord(item)?.type)))
  }
  if (request.dialect === "messages") {
    return request.body.messages.some((message) =>
      Array.isArray(message.content) && message.content.some((block) => asRecord(block)?.type === "tool_result"))
  }
  return request.body.messages.some((message) => message.role === "tool")
}

export function isAutoModeClassifier(request: ScriptedModelBody, command: string | undefined) {
  if (request.dialect !== "messages" || command === undefined) return false
  const blocks = request.body.messages.flatMap((message) => (Array.isArray(message.content) ? message.content : []))
  const texts = blocks.flatMap((block) => (block.type === "text" ? [block.text] : []))
  return texts.some((text) => text.includes("Respond with <severity>N</severity> ONLY."))
    && texts.some((text) => text.trim() === JSON.stringify({ Bash: command }))
}

export function modelRequestBody(dialect: ScriptedDialect, input: unknown): ScriptedModelBody {
  const body = asRecord(input) ?? {}
  const model = typeof body.model === "string" && body.model ? body.model : "scripted"
  if (dialect === "responses") {
    return { dialect, body: { ...body, model, input: body.input ?? "" } as ResponseCreateParams }
  }
  const messages = Array.isArray(body.messages) ? body.messages : []
  if (dialect === "messages") {
    const maxTokens = typeof body.max_tokens === "number" ? body.max_tokens : 1
    return { dialect, body: { ...body, model, max_tokens: maxTokens, messages } as MessageCreateParams }
  }
  return { dialect, body: { ...body, model, messages } as ChatCompletionCreateParams }
}

export function modelTools(body: ScriptedModelBody["body"]): ScriptedModelTool[] {
  const additional = "input" in body && Array.isArray(body.input)
    ? body.input.flatMap((item) => {
        const row = asRecord(item)
        return row?.type === "additional_tools" && Array.isArray(row.tools) ? row.tools : []
      })
    : []
  const flatten = (tools: unknown[], namespace?: string): ScriptedModelTool[] => tools.flatMap((tool) => {
    const row = asRecord(tool)
    if (row?.type === "namespace" && typeof row.name === "string" && Array.isArray(row.tools)) return flatten(row.tools, row.name)
    const fn = asRecord(row?.function)
    const name = typeof row?.name === "string" ? row.name : typeof fn?.name === "string" ? fn.name : undefined
    if (!name) return []
    const inputSchema = row?.input_schema ?? fn?.parameters
    return [{ name: namespace ? `${namespace}.${name}` : name, ...(inputSchema ? { inputSchema } : {}) }]
  })
  return flatten([...(body.tools ?? []), ...additional])
}

export async function readJson(incoming: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of incoming) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString("utf8")
  return text.trim() ? (JSON.parse(text) as unknown) : {}
}

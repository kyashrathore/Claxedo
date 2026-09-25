import { randomUUID } from "node:crypto"
import fs from "node:fs"
import { RequestError, type AgentSideConnection, type PromptResponse, type SessionNotification } from "@agentclientprotocol/sdk"
import { asString } from "@claxedo/helpers/guards"
import { holdReleaseFile, type AcpScript, type AcpStep, type AcpToolStep } from "./script"
import { deliveredToolOutput } from "./parts-fault"

export type TurnContext = {
  connection: AgentSideConnection
  sessionId: string
  scriptDir: string
  signal: AbortSignal
}

type Update = SessionNotification["update"]

const PERMISSION_OPTIONS = [
  { optionId: "allow-once", name: "Allow once", kind: "allow_once" as const },
  { optionId: "allow-always", name: "Allow always", kind: "allow_always" as const },
  { optionId: "reject-once", name: "Reject", kind: "reject_once" as const },
  { optionId: "reject-always", name: "Reject always", kind: "reject_always" as const },
]

function update(context: TurnContext, value: Update) {
  return context.connection.sessionUpdate({ sessionId: context.sessionId, update: value })
}

function textContent(text: string) {
  return { type: "content" as const, content: { type: "text" as const, text } }
}

function newCallId() {
  return `call_${randomUUID().slice(0, 8)}`
}

function splitText(text: string, chunks: number) {
  const pieces = Math.max(1, Math.min(chunks, text.length))
  const size = Math.ceil(text.length / pieces)
  const out: string[] = []
  for (let at = 0; at < text.length; at += size) out.push(text.slice(at, at + size))
  return out.length ? out : [text]
}

async function sendText(context: TurnContext, text: string, chunks = 1) {
  for (const piece of splitText(text, chunks)) {
    await update(context, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: piece } })
  }
}

async function playTool(context: TurnContext, step: AcpToolStep) {
  const toolCallId = step.id ?? newCallId()
  await update(context, {
    sessionUpdate: "tool_call",
    toolCallId,
    title: step.title,
    kind: step.tool,
    status: "in_progress",
    ...(step.input ? { rawInput: step.input } : {}),
    ...(step.locations ? { locations: step.locations } : {}),
  })
  const status = step.status ?? "completed"
  const content = step.content ?? (step.text !== undefined ? [textContent(step.text)] : [])
  const rawOutput = step.output ?? (status === "failed" ? { error: step.text ?? "The scripted tool failed" } : step.text ?? null)
  await update(context, { sessionUpdate: "tool_call_update", toolCallId, status, content, rawOutput: deliveredToolOutput(rawOutput) })
}

function diffTool(step: Extract<AcpStep, { kind: "diff" }>): AcpToolStep {
  return {
    kind: "tool",
    tool: "edit",
    title: step.title ?? `Edit ${step.path}`,
    input: { path: step.path },
    locations: [{ path: step.path }],
    content: [{ type: "diff", path: step.path, oldText: step.oldText, newText: step.newText }],
  }
}

async function playPermission(context: TurnContext, step: Extract<AcpStep, { kind: "permission" }>): Promise<PromptResponse | undefined> {
  const toolCallId = newCallId()
  const toolCall = {
    toolCallId,
    title: step.title,
    kind: step.tool,
    status: "pending" as const,
    ...(step.path ? { locations: [{ path: step.path }] } : {}),
    ...(step.input ? { rawInput: step.input } : {}),
  }
  await update(context, { sessionUpdate: "tool_call", ...toolCall })
  const response = await context.connection.requestPermission({ sessionId: context.sessionId, toolCall, options: PERMISSION_OPTIONS })
  if (response.outcome.outcome === "cancelled") return { stopReason: "cancelled" }
  const allowed = response.outcome.optionId.startsWith("allow")
  const text = step.text ?? "Done"
  await update(context, {
    sessionUpdate: "tool_call_update",
    toolCallId,
    status: allowed ? "completed" : "failed",
    content: allowed ? [textContent(text)] : [],
    rawOutput: allowed ? text : { error: "Permission denied" },
  })
  return undefined
}

async function playQuestion(context: TurnContext, step: Extract<AcpStep, { kind: "question" }>) {
  const response = await context.connection.unstable_createElicitation({
    sessionId: context.sessionId,
    mode: "form",
    message: step.message,
    requestedSchema: {
      type: "object",
      properties: { answer: { type: "string", title: "Answer", ...(step.options ? { enum: step.options } : {}) } },
      required: ["answer"],
    },
  })
  const content = response.action === "accept" ? (response.content as Record<string, unknown> | undefined) : undefined
  const answer = response.action === "accept" ? asString(content?.answer) ?? "" : response.action
  await sendText(context, `Answer: ${answer}`)
}

async function playSubagent(context: TurnContext, step: Extract<AcpStep, { kind: "subagent" }>): Promise<PromptResponse | undefined> {
  const subagentSessionId = `subagent-${randomUUID().slice(0, 8)}`
  await context.connection.notify("session/update", {
    sessionId: context.sessionId,
    update: { sessionUpdate: "subagent_spawned", subagentSessionId, name: step.name, task: step.task, capabilities: { cancel: true, close: true } },
  })
  const child = { ...context, sessionId: subagentSessionId }
  for (const inner of step.steps) {
    const result = await playStep(child, inner)
    if (result) return result
  }
  await context.connection.notify("session/update", {
    sessionId: context.sessionId,
    update: { sessionUpdate: "subagent_state_update", subagentSessionId, state: "completed" },
  })
  return undefined
}

async function hold(context: TurnContext, name: string) {
  const file = holdReleaseFile(context.scriptDir, name)
  while (!context.signal.aborted) {
    if (fs.existsSync(file)) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

async function playStep(context: TurnContext, step: AcpStep): Promise<PromptResponse | undefined> {
  switch (step.kind) {
    case "text":
      await sendText(context, step.text, step.chunks)
      return undefined
    case "reasoning":
      await update(context, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: step.text } })
      return undefined
    case "image":
      await update(context, { sessionUpdate: "agent_message_chunk", content: { type: "image", data: step.data, mimeType: step.mimeType } })
      return undefined
    case "plan":
      await update(context, { sessionUpdate: "plan", entries: step.entries })
      return undefined
    case "tool":
      await playTool(context, step)
      return undefined
    case "diff":
      await playTool(context, diffTool(step))
      return undefined
    case "permission":
      return playPermission(context, step)
    case "question":
      await playQuestion(context, step)
      return undefined
    case "subagent":
      return playSubagent(context, step)
    case "hold":
      await hold(context, step.name)
      return undefined
    case "error":
      throw RequestError.internalError(undefined, step.message)
    case "stop":
      return { stopReason: step.reason }
  }
  const unknownStep: never = step
  throw new Error(`Unknown scripted ACP step ${JSON.stringify(unknownStep)}`)
}

export async function playScript(context: TurnContext, script: AcpScript): Promise<PromptResponse> {
  for (const step of script.steps) {
    if (context.signal.aborted) return { stopReason: "cancelled" }
    const result = await playStep(context, step)
    if (result) return result
  }
  return { stopReason: script.stopReason ?? "end_turn", ...(script.usage ? { usage: script.usage } : {}) }
}

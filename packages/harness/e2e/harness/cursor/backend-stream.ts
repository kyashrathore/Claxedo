import type { ServerResponse } from "node:http"
import type { CursorScript, CursorToolStep } from "./backend"
import type { CursorDescriptors } from "./descriptors"

export function openStream(response: ServerResponse) {
  if (!response.headersSent) response.writeHead(200, { "content-type": "application/connect+proto", "connect-protocol-version": "1" })
}

export function frame(flag: number, payload: Uint8Array) {
  const header = Buffer.alloc(5)
  header[0] = flag
  header.writeUInt32BE(payload.length, 1)
  return Buffer.concat([header, Buffer.from(payload)])
}

export async function sendScript(response: ServerResponse, descriptors: CursorDescriptors, script: CursorScript) {
  if (script.error) {
    response.writeHead(script.error.status, { "content-type": "application/json" })
      .end(JSON.stringify({ message: script.error.message }))
    return
  }
  const runSSE = descriptors.service("agent/v1/agent_service").methods.runSSE
  if (!runSSE) throw new Error("Cursor SDK lacks RunSSE descriptor")
  const message = runSSE.O
  openStream(response)
  let call = 0
  for (const step of script.steps) {
    if (step.kind === "text") {
      response.write(frame(0, message.fromJson({ interactionUpdate: { textDelta: { text: step.text } } }).toBinary()))
      continue
    }
    if (step.kind === "thinking") {
      response.write(frame(0, message.fromJson({ interactionUpdate: { thinkingDelta: { text: step.text } } }).toBinary()))
      response.write(frame(0, message.fromJson({ interactionUpdate: { thinkingCompleted: { thinkingDurationMs: step.durationMs } } }).toBinary()))
      continue
    }
    if (step.kind === "update") {
      response.write(frame(0, message.fromJson({ interactionUpdate: step.update }).toBinary()))
      continue
    }
    if (step.kind === "wait") {
      await new Promise((resolve) => setTimeout(resolve, step.ms))
      continue
    }
    const tool: CursorToolStep = step.kind === "read"
      ? { kind: "tool", tool: "readToolCall", args: { path: step.path }, result: { success: { path: step.path, content: step.result } } }
      : step
    const callId = `scripted-${step.kind}-${++call}`
    response.write(frame(0, message.fromJson({ interactionUpdate: {
      toolCallStarted: { callId, toolCall: { [tool.tool]: { args: tool.args } } },
    } }).toBinary()))
    if (tool.result === undefined) continue
    response.write(frame(0, message.fromJson({ interactionUpdate: {
      toolCallCompleted: { callId, toolCall: { [tool.tool]: { args: tool.args, result: tool.result } } },
    } }).toBinary()))
  }
  response.write(frame(0, message.fromJson({ interactionUpdate: { turnEnded: {
    inputTokens: String(script.usage?.inputTokens ?? 2),
    outputTokens: String(script.usage?.outputTokens ?? 3),
  } } }).toBinary()))
  response.end(frame(2, Buffer.from("{}")))
}


import type { OutboundChunk } from "../envelope"
import type { ApprovalBridge } from "./approval-bridge"

function rec(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === "object" ? input as Record<string, unknown> : undefined
}

function textFromPart(input: unknown) {
  const row = rec(input)
  if (row?.type !== "text") return
  return typeof row.text === "string" ? row.text : undefined
}

function textFromMessageUpdated(input: Record<string, unknown>) {
  const properties = rec(input.properties)
  const info = rec(properties?.info)
  if (info?.role !== "assistant") return
  return Array.isArray(properties?.parts)
    ? properties.parts.flatMap((part) => textFromPart(part) ?? []).join("")
    : undefined
}

function textPartUpdate(input: Record<string, unknown>) {
  const properties = rec(input.properties)
  const part = rec(properties?.part)
  if (part?.type !== "text") return
  const id = typeof part.id === "string" ? part.id : "part"
  return typeof part.text === "string" ? { id, text: part.text } : undefined
}

function textFromMessagePartDelta(input: Record<string, unknown>) {
  const properties = rec(input.properties)
  if (typeof properties?.delta !== "string") return
  return properties.delta
}

function textFromRuntimeEvent(input: Record<string, unknown>) {
  if (input.type === "text-delta") return typeof input.delta === "string" ? input.delta : undefined
  if (input.type === "message.updated") return textFromMessageUpdated(input)
  if (input.type === "message.part.delta") return textFromMessagePartDelta(input)
  return undefined
}

function statusFromRuntimeEvent(input: Record<string, unknown>): Extract<OutboundChunk, { kind: "status" }> | undefined {
  if (input.type === "session-status") {
    if (input.status === "busy") return { kind: "status", phase: "running" }
    if (input.status === "idle") return { kind: "status", phase: "done" }
    if (input.status === "error") return { kind: "status", phase: "failed" }
  }
  if (input.type === "finish") return { kind: "status", phase: "done" }
  if (input.type === "error") return { kind: "status", phase: "failed" }
  return undefined
}

function approvalFromRuntimeEvent(input: Record<string, unknown>, sessionId: string, threadKey?: string) {
  if (input.type !== "permission.asked") return
  const properties = rec(input.properties)
  if (!properties || typeof properties.id !== "string") return
  return {
    callId: properties.id,
    tool: typeof properties.tool === "string" ? properties.tool : "tool",
    summary: typeof properties.title === "string"
      ? properties.title
      : typeof properties.description === "string"
        ? properties.description
        : "Permission is required to continue.",
    sessionId,
    ...(threadKey ? { threadKey } : {}),
  }
}

export async function streamRuntimeReplies(input: {
  events: AsyncIterable<unknown>
  sessionId: string
  threadKey?: string
  appUrl?: string
  approvals?: ApprovalBridge
  reply: (chunk: OutboundChunk) => void | Promise<void>
}) {
  let emittedText = false
  let failed = false
  let failureText: string | undefined
  let accumulated = ""
  const parts = new Map<string, string>()
  await input.reply({ kind: "status", phase: "running", sessionId: input.sessionId, ...(input.appUrl ? { appUrl: input.appUrl } : {}) })
  for await (const event of input.events) {
    const row = rec(event)
    if (!row) continue
    const approval = approvalFromRuntimeEvent(row, input.sessionId, input.threadKey)
    if (approval && input.approvals) {
      await input.reply(await input.approvals.request(approval))
      continue
    }
    const status = statusFromRuntimeEvent(row)
    if (status) {
      failed = failed || status.phase === "failed"
      if (row.type === "error" && typeof row.error === "string") failureText = row.error
      await input.reply({
        kind: "status",
        phase: status.phase,
        sessionId: input.sessionId,
        ...(input.appUrl ? { appUrl: input.appUrl } : {}),
      })
    }
    const partUpdate = row.type === "message.part.updated" ? textPartUpdate(row) : undefined
    if (partUpdate) {
      parts.set(partUpdate.id, partUpdate.text)
      accumulated = [...parts.values()].join("")
      emittedText = true
      await input.reply({ kind: "text", text: accumulated, final: false })
      continue
    }
    const text = textFromRuntimeEvent(row)
    if (!text) continue
    accumulated = row.type === "message.updated"
      ? text
      : `${accumulated}${text}`
    emittedText = true
    await input.reply({ kind: "text", text: accumulated, final: false })
  }
  if (!emittedText) {
    await input.reply({ kind: "text", text: `Session ${input.sessionId} updated.`, final: false })
  }
  await input.reply({
    kind: "text",
    text: failed ? `Run failed${failureText ? `: ${failureText}` : "."}` : input.appUrl ? `Open: ${input.appUrl}` : "Done.",
    final: true,
  })
}

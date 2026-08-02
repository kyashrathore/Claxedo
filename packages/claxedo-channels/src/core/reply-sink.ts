import type { ChannelSink, OutboundChunk } from "../envelope"
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

function str(input: unknown) {
  return typeof input === "string" && input.trim() ? input : undefined
}

/**
 * Map a runtime `permission.asked` event onto an `ApprovalRequest`.
 *
 * The emitted payload is `{ id, sessionID, permission, patterns, metadata:
 * { title }, always }` — the tool CLASSIFICATION lives in `permission`, and the
 * human-readable title is nested under `metadata`, not at the top level.
 * Reading `properties.tool` / `properties.title` directly matched nothing, so
 * every prompt collapsed to "tool" / "Permission is required to continue."
 * That text is what a human reads before approving and what the judge reasons
 * over, so an unmapped payload made both decide on noise.
 */
function approvalFromRuntimeEvent(input: Record<string, unknown>, context: {
  sessionId: string
  threadKey?: string
  requestee?: string
}) {
  if (input.type !== "permission.asked") return
  const properties = rec(input.properties)
  if (!properties || typeof properties.id !== "string") return
  const metadata = rec(properties.metadata)
  const patterns = Array.isArray(properties.patterns)
    ? properties.patterns.flatMap((pattern) => str(pattern) ?? [])
    : []
  const title = str(metadata?.title) ?? str(properties.title) ?? str(properties.description)
  return {
    callId: properties.id,
    tool: str(properties.permission) ?? str(properties.tool) ?? "tool",
    summary: title ?? (patterns.length
      ? `Permission is required for ${patterns.join(", ")}.`
      : "Permission is required to continue."),
    sessionId: context.sessionId,
    ...(context.threadKey ? { threadKey: context.threadKey } : {}),
    // The sender whose turn triggered the permission is the one being asked.
    ...(context.requestee ? { requestee: context.requestee } : {}),
  }
}

export async function streamRuntimeReplies(input: {
  events: AsyncIterable<unknown>
  sessionId: string
  threadKey?: string
  appUrl?: string
  /** Sender whose turn this is; recorded on approval prompts as the requestee. */
  requestee?: string
  approvals?: ApprovalBridge
  reply: ChannelSink<[OutboundChunk]>
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
    const approval = approvalFromRuntimeEvent(row, {
      sessionId: input.sessionId,
      ...(input.threadKey ? { threadKey: input.threadKey } : {}),
      ...(input.requestee ? { requestee: input.requestee } : {}),
    })
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

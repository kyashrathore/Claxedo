import { asRecord } from "@claxedo/helpers/guards"
import { canonicalToolName } from "@claxedo/agent-runtime-contract"
import type { AgentEventEnvelope, AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import { withDir } from "../presentation-events"
import type { CompatContext } from "./context"
import { lossyCompatDiagnostic, projectionDiagnostic } from "./diagnostics"
import { hydrateToolInput, mergeDisplay, mergeInput, mergeMetadata, normalizeInputKeys, normalizeLocationInput } from "./tool-input"
import { formatToolOutput, toolContentText } from "./tool-output"
import { toolEvent } from "./tool-part"

type RuntimeEvent<T extends AgentRuntimeEvent["type"]> = Extract<AgentRuntimeEvent, { type: T }>

function compatToolStatus(status: RuntimeEvent<"tool-status">["status"]) {
  if (status === "failed") return "error" as const
  return status
}

function duplicateTerminalDiagnostic(ctx: CompatContext, eventType: string) {
  return withDir(ctx.directory, projectionDiagnostic({
    sessionID: ctx.sessionId,
    phase: "ingest",
    code: "projection.client_presentation.duplicate_terminal_tool_update",
    message: "Claxedo client-presentation projection ignored a duplicate terminal tool update",
    eventType,
  }))
}

export function translateToolStart(ctx: CompatContext, chunk: RuntimeEvent<"tool-start">, now: () => number): AgentEventEnvelope[] {
  const tool = chunk.toolName ? canonicalToolName(chunk.toolName) : chunk.toolCallId
  ctx.toolNamesByCallId.set(chunk.toolCallId, tool)
  const metadata = mergeMetadata(ctx.toolMetadataByCallId.get(chunk.toolCallId), chunk.metadata)
  const display = mergeDisplay(ctx.toolDisplaysByCallId.get(chunk.toolCallId), chunk.display)
  const input = hydrateToolInput(tool, ctx.toolInputsByCallId.get(chunk.toolCallId), metadata, display)
  ctx.toolInputsByCallId.set(chunk.toolCallId, input)
  ctx.toolMetadataByCallId.set(chunk.toolCallId, metadata)
  ctx.toolDisplaysByCallId.set(chunk.toolCallId, display)
  const status = ctx.toolStatusByCallId.get(chunk.toolCallId)
  if (status === "completed" || status === "error") {
    return [
      withDir(ctx.directory, projectionDiagnostic({
        sessionID: ctx.sessionId,
        phase: "ingest",
        code: "projection.client_presentation.tool_metadata_after_terminal",
        message: "Claxedo client-presentation projection received tool metadata after a terminal update",
        eventType: chunk.type,
      })),
      toolEvent({
        ctx,
        toolCallId: chunk.toolCallId,
        tool,
        stateInput: input,
        status,
        metadata,
        now: now(),
        ...(status === "completed"
          ? { output: ctx.toolOutputsByCallId.get(chunk.toolCallId) ?? "" }
          : { error: ctx.toolErrorsByCallId.get(chunk.toolCallId) ?? "tool failed" }),
      }),
    ]
  }
  const nextStatus = ctx.toolStatusByCallId.get(chunk.toolCallId) ?? "running"
  ctx.toolStatusByCallId.set(chunk.toolCallId, nextStatus)
  return [toolEvent({
    ctx,
    toolCallId: chunk.toolCallId,
    tool,
    stateInput: input,
    status: nextStatus,
    metadata,
    now: now(),
  })]
}

export function translateToolInput(ctx: CompatContext, chunk: RuntimeEvent<"tool-input">, now: () => number): AgentEventEnvelope[] {
  const tool = ctx.toolNamesByCallId.get(chunk.toolCallId) ?? chunk.toolCallId
  const raw = asRecord(chunk.input) ?? { raw: chunk.input }
  const next = Object.keys(raw).length > 0 ? normalizeInputKeys(raw) : undefined
  const metadata = mergeMetadata(ctx.toolMetadataByCallId.get(chunk.toolCallId), chunk.metadata)
  const display = mergeDisplay(ctx.toolDisplaysByCallId.get(chunk.toolCallId), chunk.display)
  const input = hydrateToolInput(tool, mergeInput(ctx.toolInputsByCallId.get(chunk.toolCallId), next), metadata, display)
  if (Object.keys(input).length === 0 && Object.keys(metadata).length === 0) return []
  ctx.toolInputsByCallId.set(chunk.toolCallId, input)
  ctx.toolMetadataByCallId.set(chunk.toolCallId, metadata)
  ctx.toolDisplaysByCallId.set(chunk.toolCallId, display)
  ctx.toolStatusByCallId.set(chunk.toolCallId, "running")
  return [toolEvent({
    ctx,
    toolCallId: chunk.toolCallId,
    tool,
    stateInput: input,
    status: "running",
    metadata,
    now: now(),
  })]
}

export function translateToolStatus(ctx: CompatContext, chunk: RuntimeEvent<"tool-status">, now: () => number): AgentEventEnvelope[] {
  const tool = ctx.toolNamesByCallId.get(chunk.toolCallId) ?? chunk.toolCallId
  const metadata = mergeMetadata(ctx.toolMetadataByCallId.get(chunk.toolCallId), chunk.metadata)
  const display = mergeDisplay(ctx.toolDisplaysByCallId.get(chunk.toolCallId), chunk.display)
  const input = hydrateToolInput(tool, ctx.toolInputsByCallId.get(chunk.toolCallId), metadata, display)
  const status = compatToolStatus(chunk.status)
  ctx.toolInputsByCallId.set(chunk.toolCallId, input)
  ctx.toolMetadataByCallId.set(chunk.toolCallId, metadata)
  ctx.toolDisplaysByCallId.set(chunk.toolCallId, display)
  ctx.toolStatusByCallId.set(chunk.toolCallId, status)
  return [toolEvent({
    ctx,
    toolCallId: chunk.toolCallId,
    tool,
    stateInput: input,
    status,
    metadata,
    now: now(),
    ...(status === "completed" ? { output: ctx.toolOutputsByCallId.get(chunk.toolCallId) ?? "" } : {}),
    ...(status === "error" ? { error: ctx.toolErrorsByCallId.get(chunk.toolCallId) ?? "tool failed" } : {}),
  })]
}

export function translateToolContent(ctx: CompatContext, chunk: RuntimeEvent<"tool-content">, now: () => number): AgentEventEnvelope[] {
  const tool = ctx.toolNamesByCallId.get(chunk.toolCallId) ?? chunk.toolCallId
  const metadata = mergeMetadata(
    ctx.toolMetadataByCallId.get(chunk.toolCallId),
    mergeMetadata(chunk.metadata, { acp: { content: [chunk.content] } }),
  )
  const display = mergeDisplay(ctx.toolDisplaysByCallId.get(chunk.toolCallId), chunk.display)
  const input = hydrateToolInput(tool, ctx.toolInputsByCallId.get(chunk.toolCallId), metadata, display)
  const status = ctx.toolStatusByCallId.get(chunk.toolCallId) ?? "running"
  const contentText = toolContentText(chunk.content)
  ctx.toolInputsByCallId.set(chunk.toolCallId, input)
  ctx.toolMetadataByCallId.set(chunk.toolCallId, metadata)
  ctx.toolDisplaysByCallId.set(chunk.toolCallId, display)
  const event = toolEvent({
    ctx,
    toolCallId: chunk.toolCallId,
    tool,
    stateInput: input,
    status,
    metadata,
    now: now(),
    ...(status === "completed" && contentText ? { output: contentText } : {}),
  })
  if (contentText || chunk.content.type === "diff" || chunk.content.type === "terminal") return [event]
  return [
    lossyCompatDiagnostic(ctx, chunk.type, "Claxedo client-presentation projection preserved non-text ACP tool content in metadata only", chunk),
    event,
  ]
}

export function translateToolOutput(ctx: CompatContext, chunk: RuntimeEvent<"tool-output">, now: () => number): AgentEventEnvelope[] {
  const tool = ctx.toolNamesByCallId.get(chunk.toolCallId) ?? chunk.toolCallId
  const metadata = mergeMetadata(ctx.toolMetadataByCallId.get(chunk.toolCallId), chunk.metadata)
  const display = mergeDisplay(ctx.toolDisplaysByCallId.get(chunk.toolCallId), chunk.display)
  const input = hydrateToolInput(tool, ctx.toolInputsByCallId.get(chunk.toolCallId), metadata, display)
  const formatted = formatToolOutput(chunk.output, input, metadata)
  const previousStatus = ctx.toolStatusByCallId.get(chunk.toolCallId)
  if (previousStatus === "completed" || previousStatus === "error") return [duplicateTerminalDiagnostic(ctx, chunk.type)]
  ctx.toolInputsByCallId.set(chunk.toolCallId, input)
  ctx.toolMetadataByCallId.set(chunk.toolCallId, metadata)
  ctx.toolDisplaysByCallId.set(chunk.toolCallId, display)
  ctx.toolStatusByCallId.set(chunk.toolCallId, "completed")
  ctx.toolOutputsByCallId.set(chunk.toolCallId, formatted.value)
  if (chunk.attachments?.length) ctx.toolAttachmentsByCallId.set(chunk.toolCallId, chunk.attachments)
  const endedAt = now()
  return [
    ...(formatted.issues.length ? [withDir(ctx.directory, projectionDiagnostic({
      sessionID: ctx.sessionId,
      phase: "ingest",
      code: "projection.client_presentation.unserializable_output",
      message: "Claxedo client-presentation projection sanitized unserializable tool output",
      eventType: chunk.type,
      issues: formatted.issues,
    }))] : []),
    toolEvent({
      ctx,
      toolCallId: chunk.toolCallId,
      tool,
      stateInput: input,
      status: "completed",
      metadata,
      now: endedAt,
      output: formatted.value,
    })]
}

export function translateToolError(ctx: CompatContext, chunk: RuntimeEvent<"tool-error">, now: () => number): AgentEventEnvelope[] {
  const tool = ctx.toolNamesByCallId.get(chunk.toolCallId) ?? chunk.toolCallId
  const metadata = mergeMetadata(ctx.toolMetadataByCallId.get(chunk.toolCallId), chunk.metadata)
  const display = mergeDisplay(ctx.toolDisplaysByCallId.get(chunk.toolCallId), chunk.display)
  const input = hydrateToolInput(tool, ctx.toolInputsByCallId.get(chunk.toolCallId), metadata, display)
  const previousStatus = ctx.toolStatusByCallId.get(chunk.toolCallId)
  if (previousStatus === "completed" || previousStatus === "error") return [duplicateTerminalDiagnostic(ctx, chunk.type)]
  ctx.toolInputsByCallId.set(chunk.toolCallId, input)
  ctx.toolMetadataByCallId.set(chunk.toolCallId, metadata)
  ctx.toolDisplaysByCallId.set(chunk.toolCallId, display)
  ctx.toolStatusByCallId.set(chunk.toolCallId, "error")
  ctx.toolErrorsByCallId.set(chunk.toolCallId, chunk.error)
  const endedAt = now()
  return [toolEvent({
    ctx,
    toolCallId: chunk.toolCallId,
    tool,
    stateInput: input,
    status: "error",
    metadata,
    now: endedAt,
    error: chunk.error,
  })]
}

export function translateToolLocation(ctx: CompatContext, chunk: RuntimeEvent<"tool-location">, now: () => number): AgentEventEnvelope[] {
  const tool = ctx.toolNamesByCallId.get(chunk.toolCallId) ?? chunk.toolCallId
  const input = normalizeLocationInput(tool, ctx.toolInputsByCallId.get(chunk.toolCallId) ?? {}, chunk.locations)
  const metadata = mergeMetadata(ctx.toolMetadataByCallId.get(chunk.toolCallId), {
    acp: { locations: chunk.locations },
  })
  ctx.toolInputsByCallId.set(chunk.toolCallId, input)
  ctx.toolMetadataByCallId.set(chunk.toolCallId, metadata)
  return [toolEvent({
    ctx,
    toolCallId: chunk.toolCallId,
    tool,
    stateInput: input,
    status: "running",
    metadata,
    now: now(),
  })]
}

export function translateToolTerminal(ctx: CompatContext, chunk: RuntimeEvent<"tool-terminal">, now: () => number): AgentEventEnvelope[] {
  const tool = ctx.toolNamesByCallId.get(chunk.toolCallId) ?? chunk.toolCallId
  const input = ctx.toolInputsByCallId.get(chunk.toolCallId) ?? {}
  const metadata = mergeMetadata(ctx.toolMetadataByCallId.get(chunk.toolCallId), {
    acp: { terminalId: chunk.terminalId },
  })
  const status = ctx.toolStatusByCallId.get(chunk.toolCallId) ?? "running"
  ctx.toolMetadataByCallId.set(chunk.toolCallId, metadata)
  if (status === "completed" || status === "error") {
    return [toolEvent({
      ctx,
      toolCallId: chunk.toolCallId,
      tool,
      stateInput: input,
      status,
      metadata,
      now: now(),
      ...(status === "completed"
        ? { output: ctx.toolOutputsByCallId.get(chunk.toolCallId) ?? "" }
        : { error: ctx.toolErrorsByCallId.get(chunk.toolCallId) ?? "tool failed" }),
    })]
  }
  return [toolEvent({
    ctx,
    toolCallId: chunk.toolCallId,
    tool,
    stateInput: input,
    status,
    metadata,
    now: now(),
  })]
}

export function terminalizeOpenTools(ctx: CompatContext, error: string, now: () => number): AgentEventEnvelope[] {
  const endedAt = now()
  const events: AgentEventEnvelope[] = []
  for (const [toolCallId, status] of ctx.toolStatusByCallId) {
    if (status !== "running" && status !== "pending") continue
    const tool = ctx.toolNamesByCallId.get(toolCallId) ?? toolCallId
    const metadata = ctx.toolMetadataByCallId.get(toolCallId) ?? {}
    const input = hydrateToolInput(tool, ctx.toolInputsByCallId.get(toolCallId), metadata, ctx.toolDisplaysByCallId.get(toolCallId))
    ctx.toolInputsByCallId.set(toolCallId, input)
    ctx.toolStatusByCallId.set(toolCallId, "error")
    ctx.toolErrorsByCallId.set(toolCallId, error)
    events.push(toolEvent({
      ctx,
      toolCallId,
      tool,
      stateInput: input,
      status: "error",
      metadata,
      now: endedAt,
      error,
    }))
  }
  return events
}

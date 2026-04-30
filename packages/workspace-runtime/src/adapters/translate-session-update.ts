/**
 * Layer 1: ACP SessionUpdate → AgentEvent[]
 *
 * Pure function — no async, no Node imports, no side effects.
 * Exhaustiveness is enforced by `const _: never = update` in the default case.
 */

import type {
  SessionUpdate,
  ToolCallContent,
  StopReason,
  SessionConfigOption,
  SessionConfigSelectOption,
  SessionConfigSelectGroup,
  ToolKind,
} from "@agentclientprotocol/sdk"
import type { AgentEvent } from "./index"
import { createSessionState, drainContent, drainSpots, reduceTool, viewTool, type SessionState } from "./acp-state"
import { acpMode, classifyToolCall, isSessionSurface, projectToolStart } from "./acp-classify-tool"
import { diagnoseTranslation, shape } from "./acp-translation-diagnostics"
import { safeContent, safeLocations, safeMeta, safeRawInput, safeRawOutput } from "./acp-translation-validation"
import { Log } from "../log"

export type { SessionUpdate }

export interface TranslatorContext {
  state: SessionState
}

export function createTranslatorContext(client?: string): TranslatorContext {
  return { state: createSessionState(client) }
}

const log = Log.create({ service: "translate-session-update" })

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when rawInput contains at least one key — i.e. is usable structured data.
 * Rejects empty objects sent as placeholders (common in claude-agent-acp).
 */
function hasStructuredInput(raw: unknown): raw is Record<string, unknown> {
  return raw !== null && raw !== undefined && typeof raw === "object" && !Array.isArray(raw) && Object.keys(raw as object).length > 0
}

function emitInput(
  phase: "start" | "in_progress" | "completed",
  input: Record<string, unknown> | undefined,
  rawInput: unknown,
  title?: string,
  kind?: ToolKind,
  content?: ToolCallContent[] | null,
) {
  if (!input) return false
  if (phase === "start") return true
  if (hasStructuredInput(rawInput)) return true
  if (title || kind) return true
  if (phase === "completed" && (content ?? []).some((item) => item.type === "diff")) return true
  return false
}

function text(value: unknown) {
  if (typeof value !== "string") return
  if (!value) return
  return value
}

function object(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value as Record<string, unknown>
}

function errorText(value: unknown, metadata?: Record<string, unknown>) {
  const direct = text(value)
  if (direct) return direct

  const row = object(value)
  const rowText = [text(row?.stderr), text(row?.stdout)].filter((item): item is string => !!item).join("\n")
  const fromRow =
    (rowText || undefined) ??
    text(row?.message) ??
    text(row?.text) ??
    text(row?.content)
  if (fromRow) return fromRow

  const acp = object(metadata?.acp)
  const raw = object(acp?.rawOutput)
  const rawText = [text(raw?.stderr), text(raw?.stdout)].filter((item): item is string => !!item).join("\n")
  const fromMeta =
    (rawText || undefined) ??
    text(raw?.message) ??
    text(raw?.text) ??
    text(raw?.content)
  if (fromMeta) return fromMeta

  if (row || raw || value !== undefined && value !== null) {
    try {
      return JSON.stringify(value ?? raw)
    } catch {
      return String(value ?? raw)
    }
  }
  return ""
}

function flattenSelectOptions(
  options: SessionConfigSelectOption[] | SessionConfigSelectGroup[],
): Array<{ id: string; name: string }> {
  if (options.length === 0) return []
  // Detect if first element is a group (has `group` property) or an option (has `value`)
  const first = options[0] as Record<string, unknown>
  if ("group" in first) {
    // Array<SessionConfigSelectGroup>
    const groups = options as SessionConfigSelectGroup[]
    return groups.flatMap((g) =>
      g.options.map((o) => ({ id: o.value as string, name: o.name })),
    )
  }
  // Array<SessionConfigSelectOption>
  return (options as SessionConfigSelectOption[]).map((o) => ({
    id: o.value as string,
    name: o.name,
  }))
}

function mapConfigOptions(
  configOptions: SessionConfigOption[],
): AgentEvent & { type: "config-update" } {
  const options = configOptions.map((opt) => {
    if (opt.type === "select") {
      const rawOpts = opt.options ?? []
      const selectOptions = flattenSelectOptions(
        rawOpts as SessionConfigSelectOption[] | SessionConfigSelectGroup[],
      )
      return {
        id: opt.id as string,
        name: opt.name,
        category: opt.category ?? undefined,
        type: "select" as const,
        currentValue: opt.currentValue as string,
        selectOptions,
      }
    } else {
      return {
        id: opt.id as string,
        name: opt.name,
        category: opt.category ?? undefined,
        type: "boolean" as const,
        currentValue: opt.currentValue as boolean,
      }
    }
  })
  return { type: "config-update", options }
}

// ---------------------------------------------------------------------------
// Session-surface helpers
// ---------------------------------------------------------------------------

/**
 * Extract a todo-update event from the tool's accumulated rawInput.
 * Handles Claude TodoWrite ({todos: [...]}) and Cursor UpdateTodos ({todos: [...]}).
 */
function extractTodos(rawInput: Record<string, unknown> | undefined): AgentEvent | undefined {
  if (!rawInput) return
  const items = Array.isArray(rawInput.todos) ? rawInput.todos : []
  if (items.length === 0) return
  const bad = items.find((item) => {
    const row = object(item)
    return row && row.status === "cancelled"
  })
  if (bad) {
    diagnoseTranslation("acp.dropped_content", {
      reason: "todo_cancelled_status_preserved_as_string",
      shape: shape(bad),
    })
  }
  return {
    type: "todo-update",
    todos: items.map((item, i: number) => {
      const t = object(item) ?? {}
      return ({
      id: String(i),
      description: String(t?.content ?? t?.description ?? ""),
      status: String(t?.status ?? "in_progress"),
      priority: String(t?.priority ?? "medium"),
    })}),
  }
}

/**
 * Extract a question or permission-request event from the tool's rawInput.
 * question: { prompt/question, options? }
 * permission (mode=permission): { reason, scopes? }
 */
function extractQuestion(
  toolCallId: string,
  rawInput: Record<string, unknown> | undefined,
  mode: string | undefined,
): AgentEvent | undefined {
  if (!rawInput) return

  // Permission requests (Codex)
  if (mode === "permission") {
    const reason = typeof rawInput.reason === "string" ? rawInput.reason : undefined
    const tool = typeof rawInput.tool === "string" ? rawInput.tool : (reason ?? "permission")
    const scopes = Array.isArray(rawInput.scopes)
      ? rawInput.scopes.filter((s): s is string => typeof s === "string")
      : []
    return {
      type: "permission-request",
      requestId: toolCallId,
      tool,
      paths: scopes,
    }
  }

  // Freeform questions
  const questions = Array.isArray(rawInput.questions)
    ? rawInput.questions.map(object).filter((item): item is Record<string, unknown> => !!item)
    : []
  if (questions.length > 0) {
    return {
      type: "question",
      requestId: toolCallId,
      questions: questions.map((question, i) => {
        const options = Array.isArray(question.options)
          ? question.options.flatMap((option) => {
            if (typeof option === "string") return [option]
            const row = object(option)
            return text(row?.label) ? [text(row?.label)!] : []
          })
          : []
        return {
          text: text(question.prompt) ?? text(question.question) ?? text(question.text) ?? `Question ${i + 1}`,
          ...(options.length ? { options } : {}),
        }
      }),
    }
  }

  const prompt =
    (typeof rawInput.prompt === "string" ? rawInput.prompt : undefined) ??
    (typeof rawInput.question === "string" ? rawInput.question : undefined) ??
    (typeof rawInput.text === "string" ? rawInput.text : undefined)
  if (!prompt) return
  const options = Array.isArray(rawInput.options)
    ? rawInput.options.filter((o): o is string => typeof o === "string")
    : undefined
  return {
    type: "question",
    requestId: toolCallId,
    questions: [{ text: prompt, ...(options?.length ? { options } : {}) }],
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function translateSessionUpdate(
  update: SessionUpdate,
  ctx: TranslatorContext,
): AgentEvent[] {
  const kind = update.sessionUpdate

  switch (kind) {
    case "agent_message_chunk":
    case "agent_thought_chunk": {
      const isThought = kind === "agent_thought_chunk"
      const chunks: AgentEvent[] = []

      // messageId tracking for step-start (agent_message_chunk only)
      if (!isThought && "messageId" in update) {
        const newMsgId = (update as { messageId?: string | null }).messageId ?? null
        if (newMsgId !== null && newMsgId !== ctx.state.lastMessageId) {
          chunks.push({ type: "step-start", newMessageId: newMsgId })
          ctx.state.lastMessageId = newMsgId
        }
      }

      const content = update.content
      if (content.type === "text") {
        chunks.push(isThought
          ? { type: "thinking-delta", delta: content.text }
          : { type: "text-delta", delta: content.text })
      } else if (content.type === "image") {
        chunks.push({ type: "image-delta", mimeType: content.mimeType, data: content.data })
      } else if (content.type === "audio") {
        if (!isThought) {
          chunks.push({ type: "audio-delta", mimeType: content.mimeType, data: content.data })
        } else {
          diagnoseTranslation("acp.dropped_content", {
            reason: "thought_audio_not_represented",
            shape: shape(content),
          })
        }
      } else if (content.type === "resource_link") {
        if (!isThought) {
          chunks.push({
            type: "resource-link-delta",
            uri: content.uri,
            name: content.name,
            mimeType: content.mimeType ?? undefined,
            title: content.title ?? undefined,
          })
        } else {
          diagnoseTranslation("acp.dropped_content", {
            reason: "thought_resource_link_not_represented",
            shape: shape(content),
          })
        }
      } else if (content.type === "resource") {
        const resource = content.resource
        if ("text" in resource) {
          // TextResourceContents
          chunks.push(isThought
            ? { type: "thinking-delta", delta: resource.text }
            : { type: "text-delta", delta: resource.text })
        } else {
          diagnoseTranslation("acp.dropped_content", {
            reason: "blob_resource_not_represented",
            shape: shape(content),
          })
        }
      } else {
        diagnoseTranslation("acp.unknown_content_type", { kind, shape: shape(content), reason: "unknown_content_block" })
        log.warn("translateSessionUpdate: unhandled content type", { kind, contentType: (content as { type: string }).type })
      }

      return chunks
    }

    case "user_message_chunk": {
      diagnoseTranslation("acp.dropped_content", { reason: "user_message_chunk_policy", shape: shape(update) })
      return []
    }

    case "tool_call": {
      const chunks: AgentEvent[] = []
      const meta = safeMeta((update as unknown as Record<string, unknown>)._meta, {
        toolCallId: update.toolCallId,
        title: update.title,
        kind: update.kind,
      })
      const rawInput = safeRawInput(update.rawInput, { toolCallId: update.toolCallId, title: update.title, kind: update.kind })
      const content = safeContent(update.content, { toolCallId: update.toolCallId, title: update.title, kind: update.kind })
      const locations = safeLocations(update.locations, { toolCallId: update.toolCallId, title: update.title, kind: update.kind })
      const tool = reduceTool(ctx.state, update.toolCallId, {
        title: update.title,
        kind: update.kind,
        status: "running",
        rawInput,
        content,
        locations,
        meta,
      })
      const next = viewTool(tool)
      const classification = classifyToolCall(next)

      // Session-surface routing: emit session events instead of tool rows
      if (isSessionSurface(classification)) {
        if (classification.kind === "question") {
          const mode = acpMode(next.metadata)
          const q = extractQuestion(update.toolCallId, next.input, mode)
          if (q) chunks.push(q)
        }
        if (classification.kind === "todos") {
          const t = extractTodos(next.input)
          if (t) chunks.push(t)
        }
        // reasoning: suppress tool row — thinking arrives via agent_thought_chunk
        chunks.push(...drainContent(tool, content))
        chunks.push(...drainSpots(tool, locations))
        return chunks
      }

      chunks.push(projectToolStart(update.toolCallId, next, tool.kind ?? undefined))
      if (emitInput("start", next.input, rawInput, update.title, update.kind, content)) {
        chunks.push({ type: "tool-input", toolCallId: update.toolCallId, input: next.input, metadata: next.metadata })
      }
      chunks.push(...drainContent(tool, content))
      chunks.push(...drainSpots(tool, locations))
      return chunks
    }

    case "tool_call_update": {
      const { toolCallId, status, rawInput, rawOutput, content, locations, title, kind } = update as typeof update & { title?: string; kind?: ToolKind }
      const meta = safeMeta((update as unknown as Record<string, unknown>)._meta, { toolCallId, title: title ?? undefined, kind })
      const safeInput = safeRawInput(rawInput, { toolCallId, title: title ?? undefined, kind })
      const safeOutput = safeRawOutput(rawOutput, { toolCallId, title: title ?? undefined, kind })
      const safeItems = safeContent(content, { toolCallId, title: title ?? undefined, kind })
      const safeSpots = safeLocations(locations, { toolCallId, title: title ?? undefined, kind })
      const nextStatus =
        status === "completed" || status === "failed"
          ? status
          : status === "in_progress"
            ? "running"
            : "pending"
      const tool = reduceTool(ctx.state, toolCallId, {
        title,
        kind,
        status: nextStatus,
        rawInput: safeInput,
        rawOutput: safeOutput,
        content: safeItems,
        locations: safeSpots,
        meta,
      })
      const next = viewTool(tool)
      const classification = classifyToolCall(next)

      // Session-surface routing: emit session events instead of tool rows
      if (isSessionSurface(classification)) {
        const chunks: AgentEvent[] = []
        if (classification.kind === "todos" && (status === "completed" || status === "in_progress")) {
          const t = extractTodos(next.input)
          if (t) chunks.push(t)
        }
        // question: already emitted on tool_call start; updates are no-ops
        // reasoning: suppress tool row
        chunks.push(...drainContent(tool, safeItems))
        chunks.push(...drainSpots(tool, safeSpots))
        return chunks
      }

      if (status === "completed") {
        const output = safeOutput != null ? safeOutput : (safeItems ?? null)
        const chunks: AgentEvent[] = []
        if (emitInput("completed", next.input, safeInput, title, kind, safeItems)) {
          chunks.push({ type: "tool-input", toolCallId, input: next.input, metadata: next.metadata })
        }
        chunks.push({ type: "tool-output", toolCallId, output, metadata: next.metadata })
        chunks.push(...drainContent(tool, safeItems))
        chunks.push(...drainSpots(tool, safeSpots))
        return chunks
      }

      if (status === "failed") {
        const chunks: AgentEvent[] = []
        if (emitInput("completed", next.input, safeInput, title, kind, safeItems)) {
          chunks.push({ type: "tool-input", toolCallId, input: next.input, metadata: next.metadata })
        }
        const error = errorText(safeOutput, next.metadata)
        if (!error && safeOutput !== undefined && safeOutput !== null) {
          diagnoseTranslation("acp.empty_error_extraction", {
            toolCallId,
            title: title ?? undefined,
            kind,
            shape: shape(safeOutput),
            reason: "payload_without_error_text",
          })
        }
        chunks.push({
          type: "tool-error",
          toolCallId,
          error: error || (safeOutput !== undefined && safeOutput !== null ? JSON.stringify({ raw: safeOutput }) : ""),
          metadata: next.metadata,
        })
        chunks.push(...drainContent(tool, safeItems))
        chunks.push(...drainSpots(tool, safeSpots))
        return chunks
      }

      if (status === "in_progress") {
        const chunks: AgentEvent[] = []
        if (emitInput("in_progress", next.input, safeInput, title, kind, safeItems)) {
          chunks.push({ type: "tool-input", toolCallId, input: next.input, metadata: next.metadata })
        }
        chunks.push(...drainContent(tool, safeItems))
        chunks.push(...drainSpots(tool, safeSpots))
        return chunks
      }

      // status === "pending", null, undefined → no-op
      diagnoseTranslation("acp.dropped_content", { toolCallId, title: title ?? undefined, kind, reason: "pending_tool_update_policy" })
      return []
    }

    case "plan": {
      const todos = update.entries.map((e, i) => ({
        id: String(i),
        description: e.content,
        status: e.status,
        priority: e.priority,
      }))
      return [{ type: "todo-update", todos }]
    }

    case "available_commands_update": {
      diagnoseTranslation("acp.dropped_content", { reason: "available_commands_update_policy", shape: shape(update) })
      return []
    }

    case "current_mode_update": {
      return [{ type: "session-agent", agentId: update.currentModeId }]
    }

    case "config_option_update": {
      return [mapConfigOptions(update.configOptions)]
    }

    case "session_info_update": {
      if (update.title) {
        return [{ type: "session-title", title: update.title }]
      }
      diagnoseTranslation("acp.dropped_content", { reason: "session_info_without_title_policy", shape: shape(update) })
      return []
    }

    case "usage_update": {
      const chunk: AgentEvent = {
        type: "usage",
        contextSize: update.size,
        contextUsed: update.used,
      }
      if (update.cost) {
        return [{ ...chunk, cost: { amount: update.cost.amount, currency: update.cost.currency } }]
      }
      return [chunk]
    }

    default: {
      const _: never = update // compile error if SDK adds unhandled variant
      log.warn("translateSessionUpdate: unknown variant", { update })
      return []
    }
  }
}

export function translateStopReason(
  stopReason: StopReason,
  sessionId: string,
): AgentEvent[] {
  switch (stopReason) {
    case "end_turn":
    case "max_tokens":
    case "max_turn_requests":
      return [
        { type: "session-status", status: "idle" },
        { type: "finish", sessionId },
      ]
    case "cancelled":
      return [{ type: "session-status", status: "idle" }]
    case "refusal":
      return [
        { type: "session-status", status: "error" },
        { type: "error", error: "Request refused by agent" },
      ]
    default: {
      const _: never = stopReason
      log.warn("translateStopReason: unknown stopReason", { stopReason })
      return [{ type: "session-status", status: "idle" }, { type: "finish", sessionId }]
    }
  }
}

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
import type { AcpIntent } from "./acp-registry"
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
  const rowText = [text(row?.stdout), text(row?.stderr)].filter((item): item is string => !!item).join("\n")
  const fromRow =
    text(row?.formatted_output) ??
    text(row?.formattedOutput) ??
    text(row?.aggregated_output) ??
    text(row?.aggregatedOutput) ??
    (rowText || undefined) ??
    text(row?.content) ??
    text(row?.text) ??
    text(row?.body)
  if (fromRow) return fromRow

  const acp = object(metadata?.acp)
  const raw = object(acp?.rawOutput)
  const rawText = [text(raw?.stdout), text(raw?.stderr)].filter((item): item is string => !!item).join("\n")
  const fromMeta =
    text(raw?.formatted_output) ??
    text(raw?.formattedOutput) ??
    text(raw?.aggregated_output) ??
    text(raw?.aggregatedOutput) ??
    (rawText || undefined) ??
    text(raw?.content) ??
    text(raw?.text) ??
    text(raw?.body)
  if (fromMeta) return fromMeta

  if (row || raw) {
    try {
      return JSON.stringify(value ?? raw)
    } catch {}
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

/** Intent families that project to session surfaces instead of tool rows. */
const SESSION_SURFACE_INTENTS: Set<AcpIntent> = new Set(["todos", "question", "reasoning"])

function acpIntent(metadata: Record<string, unknown>): AcpIntent | undefined {
  const acp = metadata?.acp
  if (!acp || typeof acp !== "object" || Array.isArray(acp)) return
  return (acp as Record<string, unknown>).intent as AcpIntent | undefined
}

function acpMode(metadata: Record<string, unknown>): string | undefined {
  const acp = metadata?.acp
  if (!acp || typeof acp !== "object" || Array.isArray(acp)) return
  return (acp as Record<string, unknown>).mode as string | undefined
}

/**
 * Extract a todo-update event from the tool's accumulated rawInput.
 * Handles Claude TodoWrite ({todos: [...]}) and Cursor UpdateTodos ({todos: [...]}).
 */
function extractTodos(rawInput: Record<string, unknown> | undefined): AgentEvent | undefined {
  if (!rawInput) return
  const items = Array.isArray(rawInput.todos) ? rawInput.todos : []
  if (items.length === 0) return
  return {
    type: "todo-update",
    todos: items.map((t: Record<string, unknown>, i: number) => ({
      id: String(i),
      description: String(t?.content ?? t?.description ?? ""),
      status: String(t?.status ?? "in_progress"),
      priority: String(t?.priority ?? "medium"),
    })),
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
        }
        // audio in thought_chunk → dropped
      } else if (content.type === "resource_link") {
        if (!isThought) {
          chunks.push({
            type: "resource-link-delta",
            uri: content.uri,
            name: content.name,
            mimeType: content.mimeType ?? undefined,
            title: content.title ?? undefined,
          })
        }
        // resource_link in thought_chunk → dropped
      } else if (content.type === "resource") {
        const resource = content.resource
        if ("text" in resource) {
          // TextResourceContents
          chunks.push(isThought
            ? { type: "thinking-delta", delta: resource.text }
            : { type: "text-delta", delta: resource.text })
        }
        // BlobResourceContents → dropped
      } else {
        log.warn("translateSessionUpdate: unhandled content type", { kind, contentType: (content as { type: string }).type })
      }

      return chunks
    }

    case "user_message_chunk": {
      return []
    }

    case "tool_call": {
      const chunks: AgentEvent[] = []
      const tool = reduceTool(ctx.state, update.toolCallId, {
        title: update.title,
        kind: update.kind,
        status: "running",
        rawInput: update.rawInput,
        content: update.content,
        locations: update.locations,
      })
      const next = viewTool(tool)
      const intent = acpIntent(next.metadata)

      // Session-surface routing: emit session events instead of tool rows
      if (intent && SESSION_SURFACE_INTENTS.has(intent)) {
        if (intent === "question") {
          const mode = acpMode(next.metadata)
          const q = extractQuestion(update.toolCallId, next.input, mode)
          if (q) chunks.push(q)
        }
        if (intent === "todos") {
          const t = extractTodos(next.input)
          if (t) chunks.push(t)
        }
        // reasoning: suppress tool row — thinking arrives via agent_thought_chunk
        chunks.push(...drainContent(tool, update.content))
        chunks.push(...drainSpots(tool, update.locations))
        return chunks
      }

      chunks.push({
        type: "tool-start",
        toolCallId: update.toolCallId,
        toolName: next.toolName,
        kind: tool.kind ?? undefined,
        metadata: next.metadata,
      })
      if (emitInput("start", next.input, update.rawInput, update.title, update.kind, update.content)) {
        chunks.push({ type: "tool-input", toolCallId: update.toolCallId, input: next.input, metadata: next.metadata })
      }
      chunks.push(...drainContent(tool, update.content))
      chunks.push(...drainSpots(tool, update.locations))
      return chunks
    }

    case "tool_call_update": {
      const { toolCallId, status, rawInput, rawOutput, content, locations, title, kind } = update as typeof update & { title?: string; kind?: ToolKind }
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
        rawInput,
        rawOutput,
        content,
        locations,
      })
      const next = viewTool(tool)
      const intent = acpIntent(next.metadata)

      // Session-surface routing: emit session events instead of tool rows
      if (intent && SESSION_SURFACE_INTENTS.has(intent)) {
        const chunks: AgentEvent[] = []
        if (intent === "todos" && (status === "completed" || status === "in_progress")) {
          const t = extractTodos(next.input)
          if (t) chunks.push(t)
        }
        // question: already emitted on tool_call start; updates are no-ops
        // reasoning: suppress tool row
        chunks.push(...drainContent(tool, content))
        chunks.push(...drainSpots(tool, locations))
        return chunks
      }

      if (status === "completed") {
        const output = rawOutput != null ? rawOutput : (content ?? null)
        const chunks: AgentEvent[] = []
        if (emitInput("completed", next.input, rawInput, title, kind, content)) {
          chunks.push({ type: "tool-input", toolCallId, input: next.input, metadata: next.metadata })
        }
        chunks.push({ type: "tool-output", toolCallId, output, metadata: next.metadata })
        chunks.push(...drainContent(tool, content))
        chunks.push(...drainSpots(tool, locations))
        return chunks
      }

      if (status === "failed") {
        const chunks: AgentEvent[] = []
        if (emitInput("completed", next.input, rawInput, title, kind, content)) {
          chunks.push({ type: "tool-input", toolCallId, input: next.input, metadata: next.metadata })
        }
        chunks.push({
          type: "tool-error",
          toolCallId,
          error: errorText(rawOutput, next.metadata),
          metadata: next.metadata,
        })
        chunks.push(...drainContent(tool, content))
        chunks.push(...drainSpots(tool, locations))
        return chunks
      }

      if (status === "in_progress") {
        const chunks: AgentEvent[] = []
        if (emitInput("in_progress", next.input, rawInput, title, kind, content)) {
          chunks.push({ type: "tool-input", toolCallId, input: next.input, metadata: next.metadata })
        }
        chunks.push(...drainContent(tool, content))
        chunks.push(...drainSpots(tool, locations))
        return chunks
      }

      // status === "pending", null, undefined → no-op
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

/**
 * Layer 2: UIMessageChunk -> CompatEvent[]
 *
 * This stays local to workspace-runtime's ACP flow. The shared external contract
 * is CompatEvent, not UIMessageChunk.
 */

import type { UIMessageChunk } from "./index"
import {
  type CompatEnvelope,
  buildAssistantMessage,
  buildSession,
  messageCompleted,
  messagePartDelta,
  messagePartUpdated,
  messageUpdated,
  permissionAsked,
  questionAsked,
  sessionAgent,
  sessionConfig,
  sessionError,
  sessionIdle,
  sessionStatus,
  sessionTodo,
  sessionUpdated,
  sessionUsage,
  todoUpdated,
  withDir,
} from "../compat-events"

export interface ChunkToEventContext {
  sessionId: string
  directory: string
  assistantMsgId: string
  accumulatedText: string
  accumulatedThinkingText: string
  toolNamesByCallId: Record<string, string>
  partIdMap: Record<string, string>
  toolInputsByCallId: Record<string, Record<string, unknown>>
  toolMetadataByCallId: Record<string, Record<string, unknown>>
  toolStatusByCallId: Record<string, "running" | "completed" | "error">
  textPartSeq: number
  reasoningPartSeq: number
  splitText: boolean
  splitReasoning: boolean
}

function normalizeInputKeys(input: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    result[key] = value
    const camel = key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
    if (camel !== key) result[camel] = value
  }
  return result
}

function object(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value as Record<string, unknown>
}

function text(value: unknown) {
  if (typeof value !== "string") return
  if (!value) return
  return value
}

function mergeInput(
  left: Record<string, unknown> | undefined,
  right: Record<string, unknown> | undefined,
) {
  if (!left) return right ?? {}
  if (!right) return left
  return { ...left, ...right }
}

function mergeMetadata(
  left: Record<string, unknown> | undefined,
  right: Record<string, unknown> | undefined,
) {
  if (!left) return right ?? {}
  if (!right) return left
  const item = { ...left, ...right }
  const lhs = object(left.acp)
  const rhs = object(right.acp)
  if (lhs || rhs) item.acp = { ...(lhs ?? {}), ...(rhs ?? {}) }
  return item
}

function diff(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) return false
  return value.every((item) => {
    const row = object(item)
    if (!row) return false
    return "path" in row || "oldText" in row || "newText" in row
  })
}

function shell(
  input: Record<string, unknown>,
  metadata: Record<string, unknown>,
) {
  if (typeof input.intent === "string") return input.intent === "shell"
  const acp = object(metadata.acp)
  return acp?.intent === "shell"
}

function output(
  value: unknown,
  input: Record<string, unknown>,
  metadata: Record<string, unknown>,
) {
  if (typeof value === "string") return value
  if (value == null) return ""

  const row = object(value)
  if (row && shell(input, metadata)) {
    const stdout = text(row.stdout)
    const stderr = text(row.stderr)
    const list = [stdout, stderr].filter((item): item is string => !!item)
    if (list.length > 0) return list.join("\n")
  }

  if (diff(value)) return ""

  if (row) {
    const body = text(row.content) ?? text(row.text) ?? text(row.body) ?? text(row.stdout) ?? text(row.stderr)
    if (body) return body
    const scalar = Object.values(row).every((item) =>
      item == null || typeof item === "string" || typeof item === "number" || typeof item === "boolean",
    )
    if (scalar) return ""
  }

  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value.join("\n")
  }

  return JSON.stringify(value)
}

function seqId(ctx: ChunkToEventContext, id: string): string {
  if (!ctx.partIdMap[id]) {
    const seq = Object.keys(ctx.partIdMap).length
    ctx.partIdMap[id] = `${String(seq).padStart(6, "0")}_${id}`
  }
  return ctx.partIdMap[id]
}

function seen(ctx: ChunkToEventContext, id: string): boolean {
  return !!ctx.partIdMap[id]
}

function partEvent(
  directory: string,
  part: Parameters<typeof messagePartUpdated>[0],
): CompatEnvelope {
  return withDir(directory, messagePartUpdated(part))
}

function deltaText(
  ctx: ChunkToEventContext,
  type: "text" | "reasoning",
  delta: string,
): CompatEnvelope[] {
  const seqKey = type === "text" ? "textPartSeq" : "reasoningPartSeq"
  const splitKey = type === "text" ? "splitText" : "splitReasoning"
  const partKey = () => `${ctx.assistantMsgId}-${type}${ctx[seqKey] > 0 ? `-${ctx[seqKey]}` : ""}`
  if (ctx[splitKey] && seen(ctx, partKey())) {
    ctx[seqKey] += 1
  }
  ctx[splitKey] = false
  const key = partKey()
  const fresh = !seen(ctx, key)
  const id = seqId(ctx, key)
  const base =
    type === "text"
      ? {
          id,
          sessionID: ctx.sessionId,
          messageID: ctx.assistantMsgId,
          type: "text" as const,
          text: fresh ? "" : ctx.accumulatedText,
        }
      : {
          id,
          sessionID: ctx.sessionId,
          messageID: ctx.assistantMsgId,
          type: "reasoning" as const,
          text: fresh ? "" : ctx.accumulatedThinkingText,
          time: { start: Date.now() },
        }
  const events = fresh ? [partEvent(ctx.directory, base)] : []
  events.push(
    withDir(
      ctx.directory,
      messagePartDelta({
        sessionID: ctx.sessionId,
        messageID: ctx.assistantMsgId,
        partID: id,
        field: "text",
        delta,
      }),
    ),
  )
  return events
}

function normalizeLocationInput(
  tool: string,
  input: Record<string, unknown>,
  locations: Array<{ path: string; line?: number }>,
) {
  const first = locations[0]?.path
  if (!first) return input
  const intent = typeof input.intent === "string" ? input.intent : undefined
  if ((tool === "read" || tool === "lint" || intent === "read" || intent === "lint" || intent === "edit" || intent === "delete") && typeof input.filePath !== "string") {
    return {
      ...input,
      filePath: first,
    }
  }
  if ((tool === "list" || tool === "glob" || tool === "grep" || intent === "search" || intent === "list") && typeof input.path !== "string") {
    return {
      ...input,
      path: first,
    }
  }
  return input
}

function todos(chunk: Extract<UIMessageChunk, { type: "todo-update" }>) {
  return chunk.todos.map((todo) => ({
    content: todo.description,
    status: todo.status,
    priority: todo.priority ?? "medium",
  }))
}

function questions(chunk: Extract<UIMessageChunk, { type: "question" }>) {
  return chunk.questions.map((question, i) => ({
    question: question.text,
    header: question.text.slice(0, 30) || `Question ${i + 1}`,
    options: (question.options ?? []).map((label) => ({
      label,
      description: label,
    })),
    custom: !question.options?.length,
  }))
}

export function translateChunkToEvent(chunk: UIMessageChunk, ctx: ChunkToEventContext): CompatEnvelope[] {
  const split = () => {
    ctx.splitText = true
    ctx.splitReasoning = true
  }

  switch (chunk.type) {
    case "session-status":
      if (chunk.status === "error") {
        return [withDir(ctx.directory, sessionError("session error", ctx.sessionId))]
      }
      if (chunk.status === "recovering") {
        return [withDir(ctx.directory, sessionStatus(ctx.sessionId, {
          type: "recovering",
          kind: "process_restart",
          message: "Recovering ACP client...",
        }))]
      }
      return [withDir(ctx.directory, sessionStatus(ctx.sessionId, { type: chunk.status }))]

    case "text-delta":
      return deltaText(ctx, "text", chunk.delta)

    case "thinking-delta":
      return deltaText(ctx, "reasoning", chunk.delta)

    case "tool-start": {
      split()
      const tool = chunk.toolName || chunk.toolCallId
      ctx.toolNamesByCallId[chunk.toolCallId] = tool
      const input = ctx.toolInputsByCallId[chunk.toolCallId] ?? {}
      const metadata = mergeMetadata(ctx.toolMetadataByCallId[chunk.toolCallId], chunk.metadata)
      ctx.toolMetadataByCallId[chunk.toolCallId] = metadata
      ctx.toolStatusByCallId[chunk.toolCallId] = "running"
      return [partEvent(ctx.directory, {
        id: seqId(ctx, chunk.toolCallId),
        sessionID: ctx.sessionId,
        messageID: ctx.assistantMsgId,
        type: "tool",
        callID: chunk.toolCallId,
        tool,
        state: {
          status: "running",
          input,
          ...(Object.keys(metadata).length ? { metadata } : {}),
          time: { start: Date.now() },
        },
      })]
    }

    case "tool-input": {
      split()
      const tool = ctx.toolNamesByCallId[chunk.toolCallId] ?? chunk.toolCallId
      const raw = chunk.input !== null && typeof chunk.input === "object"
        ? chunk.input as Record<string, unknown>
        : { raw: chunk.input }
      const next = Object.keys(raw).length > 0 ? normalizeInputKeys(raw) : undefined
      const input = mergeInput(ctx.toolInputsByCallId[chunk.toolCallId], next)
      const metadata = mergeMetadata(ctx.toolMetadataByCallId[chunk.toolCallId], chunk.metadata)
      if (Object.keys(input).length === 0 && Object.keys(metadata).length === 0) return []
      ctx.toolInputsByCallId[chunk.toolCallId] = input
      ctx.toolMetadataByCallId[chunk.toolCallId] = metadata
      ctx.toolStatusByCallId[chunk.toolCallId] = "running"
      return [partEvent(ctx.directory, {
        id: seqId(ctx, chunk.toolCallId),
        sessionID: ctx.sessionId,
        messageID: ctx.assistantMsgId,
        type: "tool",
        callID: chunk.toolCallId,
        tool,
        state: {
          status: "running",
          input,
          ...(Object.keys(metadata).length ? { metadata } : {}),
          time: { start: Date.now() },
        },
      })]
    }

    case "tool-output": {
      split()
      const tool = ctx.toolNamesByCallId[chunk.toolCallId] ?? chunk.toolCallId
      const input = ctx.toolInputsByCallId[chunk.toolCallId] ?? {}
      const metadata = mergeMetadata(ctx.toolMetadataByCallId[chunk.toolCallId], chunk.metadata)
      ctx.toolMetadataByCallId[chunk.toolCallId] = metadata
      ctx.toolStatusByCallId[chunk.toolCallId] = "completed"
      const value = output(chunk.output, input, metadata)
      const now = Date.now()
      return [partEvent(ctx.directory, {
        id: seqId(ctx, chunk.toolCallId),
        sessionID: ctx.sessionId,
        messageID: ctx.assistantMsgId,
        type: "tool",
        callID: chunk.toolCallId,
        tool,
        state: {
          status: "completed",
          input,
          output: value,
          title: tool,
          metadata,
          time: { start: now, end: now },
        },
      })]
    }

    case "tool-error": {
      split()
      const tool = ctx.toolNamesByCallId[chunk.toolCallId] ?? chunk.toolCallId
      const input = ctx.toolInputsByCallId[chunk.toolCallId] ?? {}
      const metadata = mergeMetadata(ctx.toolMetadataByCallId[chunk.toolCallId], chunk.metadata)
      ctx.toolMetadataByCallId[chunk.toolCallId] = metadata
      ctx.toolStatusByCallId[chunk.toolCallId] = "error"
      const now = Date.now()
      return [partEvent(ctx.directory, {
        id: seqId(ctx, chunk.toolCallId),
        sessionID: ctx.sessionId,
        messageID: ctx.assistantMsgId,
        type: "tool",
        callID: chunk.toolCallId,
        tool,
        state: {
          status: "error",
          input,
          error: chunk.error,
          ...(Object.keys(metadata).length ? { metadata } : {}),
          time: { start: now, end: now },
        },
      })]
    }

    case "file-diff":
      split()
      return [partEvent(ctx.directory, {
        id: seqId(ctx, `${ctx.assistantMsgId}-diff-${chunk.path}`),
        sessionID: ctx.sessionId,
        messageID: ctx.assistantMsgId,
        type: "diff",
        path: chunk.path,
        oldText: chunk.oldText,
        newText: chunk.newText,
      })]

    case "step-start":
      return [withDir(ctx.directory, messageCompleted(ctx.sessionId, ctx.assistantMsgId))]

    case "finish":
      return [
        withDir(ctx.directory, messageCompleted(ctx.sessionId, ctx.assistantMsgId)),
        withDir(ctx.directory, sessionIdle(ctx.sessionId)),
      ]

    case "error":
      return [withDir(ctx.directory, sessionError(chunk.error, ctx.sessionId))]

    case "permission-request":
      return [withDir(ctx.directory, permissionAsked({
        id: chunk.requestId,
        sessionID: ctx.sessionId,
        permission: chunk.tool,
        patterns: chunk.paths,
        metadata: {},
        always: chunk.paths,
      }))]

    case "question":
      return [withDir(ctx.directory, questionAsked({
        id: chunk.requestId,
        sessionID: ctx.sessionId,
        questions: questions(chunk),
      }))]

    case "todo-update": {
      const list = todos(chunk)
      return [
        withDir(ctx.directory, todoUpdated(ctx.sessionId, list)),
        withDir(ctx.directory, sessionTodo(ctx.sessionId, list)),
      ]
    }

    case "image-delta":
      split()
      return [partEvent(ctx.directory, {
        id: seqId(ctx, `${ctx.assistantMsgId}-image`),
        sessionID: ctx.sessionId,
        messageID: ctx.assistantMsgId,
        type: "image",
        mimeType: chunk.mimeType,
        data: chunk.data,
      })]

    case "audio-delta":
      split()
      return [partEvent(ctx.directory, {
        id: seqId(ctx, `${ctx.assistantMsgId}-audio`),
        sessionID: ctx.sessionId,
        messageID: ctx.assistantMsgId,
        type: "audio",
        mimeType: chunk.mimeType,
        data: chunk.data,
      })]

    case "resource-link-delta":
      split()
      return [partEvent(ctx.directory, {
        id: seqId(ctx, `${ctx.assistantMsgId}-resource-link`),
        sessionID: ctx.sessionId,
        messageID: ctx.assistantMsgId,
        type: "resource-link",
        uri: chunk.uri,
        name: chunk.name,
        mimeType: chunk.mimeType,
      })]

    case "tool-location": {
      split()
      const tool = ctx.toolNamesByCallId[chunk.toolCallId] ?? chunk.toolCallId
      const input = normalizeLocationInput(tool, ctx.toolInputsByCallId[chunk.toolCallId] ?? {}, chunk.locations)
      const metadata = mergeMetadata(ctx.toolMetadataByCallId[chunk.toolCallId], {
        acp: { locations: chunk.locations },
      })
      ctx.toolInputsByCallId[chunk.toolCallId] = input
      ctx.toolMetadataByCallId[chunk.toolCallId] = metadata
      return [partEvent(ctx.directory, {
        id: seqId(ctx, chunk.toolCallId),
        sessionID: ctx.sessionId,
        messageID: ctx.assistantMsgId,
        type: "tool",
        callID: chunk.toolCallId,
        tool,
        state: {
          status: "running",
          input,
          ...(Object.keys(metadata).length ? { metadata } : {}),
          time: { start: Date.now() },
        },
      })]
    }

    case "tool-terminal": {
      split()
      const tool = ctx.toolNamesByCallId[chunk.toolCallId] ?? chunk.toolCallId
      const input = ctx.toolInputsByCallId[chunk.toolCallId] ?? {}
      const metadata = mergeMetadata(ctx.toolMetadataByCallId[chunk.toolCallId], {
        acp: { terminalId: chunk.terminalId },
      })
      const status = ctx.toolStatusByCallId[chunk.toolCallId] ?? "running"
      ctx.toolMetadataByCallId[chunk.toolCallId] = metadata
      if (status === "completed" || status === "error") {
        return [partEvent(ctx.directory, {
          id: seqId(ctx, `${chunk.toolCallId}-terminal`),
          sessionID: ctx.sessionId,
          messageID: ctx.assistantMsgId,
          type: "terminal",
          ptyId: chunk.terminalId,
        })]
      }
      return [
        partEvent(ctx.directory, {
          id: seqId(ctx, chunk.toolCallId),
          sessionID: ctx.sessionId,
          messageID: ctx.assistantMsgId,
          type: "tool",
          callID: chunk.toolCallId,
          tool,
          state: {
            status,
            input,
            ...(Object.keys(metadata).length ? { metadata } : {}),
            time: { start: Date.now() },
          },
        }),
        partEvent(ctx.directory, {
          id: seqId(ctx, `${chunk.toolCallId}-terminal`),
          sessionID: ctx.sessionId,
          messageID: ctx.assistantMsgId,
          type: "terminal",
          ptyId: chunk.terminalId,
        }),
      ]
    }

    case "session-agent":
      return [withDir(ctx.directory, sessionAgent(ctx.sessionId, chunk.agentId))]

    case "config-update":
      return [withDir(ctx.directory, sessionConfig({
        sessionID: ctx.sessionId,
        options: chunk.options,
      }))]

    case "session-title":
      return [withDir(ctx.directory, sessionUpdated(buildSession({
        id: ctx.sessionId,
        directory: ctx.directory,
        title: chunk.title,
      })))]

    case "usage":
      return [withDir(ctx.directory, sessionUsage({
        sessionID: ctx.sessionId,
        contextSize: chunk.contextSize,
        contextUsed: chunk.contextUsed,
        ...(chunk.cost ? { cost: chunk.cost } : {}),
      }))]

    case "subagent-spawned":
      return []

    default: {
      const _: never = chunk
      return []
    }
  }
}

import type { CompatEvent, CompatPart } from "../compat-events"
import { chunk } from "../types/status"
import type { UIMessageChunk } from "./index"

export interface EventToChunkContext {
  partKinds: Record<string, CompatPart["type"]>
}

export function createEventChunkContext(): EventToChunkContext {
  return { partKinds: {} }
}

function err(event: Extract<CompatEvent, { type: "session.error" }>): string {
  const error = event.properties.error
  if (!error) return "session error"
  if ("data" in error && error.data && typeof error.data.message === "string") return error.data.message
  return "session error"
}

function questionOptions(input: Extract<CompatEvent, { type: "question.asked" }>["properties"]["questions"][number]) {
  return input.options.map((option) => option.label)
}

export function translateEventToChunk(event: CompatEvent, ctx: EventToChunkContext): UIMessageChunk[] {
  switch (event.type) {
    case "session.status": {
      return [{ type: "session-status", status: chunk(event.properties.status) }]
    }

    case "session.idle":
      return [{ type: "finish", sessionId: event.properties.sessionID }]

    case "session.error":
      return [{ type: "error", error: err(event) }]

    case "message.part.updated": {
      const part = event.properties.part
      ctx.partKinds[part.id] = part.type
      if (part.type === "tool") {
        if (part.state.status === "running") {
          const chunks: UIMessageChunk[] = [{
            type: "tool-start",
            toolCallId: part.callID,
            toolName: part.tool,
            metadata: part.state.metadata,
          }]
          if (Object.keys(part.state.input).length > 0) {
            chunks.push({ type: "tool-input", toolCallId: part.callID, input: part.state.input, metadata: part.state.metadata })
          }
          return chunks
        }
        if (part.state.status === "completed") {
          return [{ type: "tool-output", toolCallId: part.callID, output: part.state.output, metadata: part.state.metadata }]
        }
        if (part.state.status === "error") {
          return [{ type: "tool-error", toolCallId: part.callID, error: part.state.error, metadata: part.state.metadata }]
        }
      }
      if (part.type === "diff") {
        return [{
          type: "file-diff",
          path: part.path,
          oldText: part.oldText,
          newText: part.newText,
        }]
      }
      if (part.type === "image") {
        return [{ type: "image-delta", mimeType: part.mimeType, data: part.data }]
      }
      if (part.type === "audio") {
        return [{ type: "audio-delta", mimeType: part.mimeType, data: part.data }]
      }
      if (part.type === "resource-link") {
        return [{
          type: "resource-link-delta",
          uri: part.uri,
          name: part.name,
          mimeType: part.mimeType,
        }]
      }
      if (part.type === "terminal") {
        return [{
          type: "tool-terminal",
          toolCallId: part.id,
          terminalId: part.ptyId,
        }]
      }
      return []
    }

    case "message.part.delta": {
      if (event.properties.field !== "text") return []
      const kind = ctx.partKinds[event.properties.partID]
      if (kind === "reasoning") return [{ type: "thinking-delta", delta: event.properties.delta }]
      return [{ type: "text-delta", delta: event.properties.delta }]
    }

    case "permission.asked":
      return [{
        type: "permission-request",
        requestId: event.properties.id,
        tool: event.properties.permission,
        paths: event.properties.patterns,
      }]

    case "question.asked":
      return [{
        type: "question",
        requestId: event.properties.id,
        questions: event.properties.questions.map((question) => ({
          text: question.question,
          ...(question.options.length ? { options: questionOptions(question) } : {}),
        })),
      }]

    case "todo.updated":
    case "session.todo":
      return [{
        type: "todo-update",
        todos: event.properties.todos.map((todo, i) => ({
          id: String(i),
          description: todo.content,
          status: todo.status,
          priority: todo.priority,
        })),
      }]

    case "session.agent":
      return [{ type: "session-agent", agentId: event.properties.agentId }]

    case "session.config":
      return [{ type: "config-update", options: event.properties.options }]

    case "session.usage":
      return [{
        type: "usage",
        contextSize: event.properties.contextSize,
        contextUsed: event.properties.contextUsed,
        ...(event.properties.cost ? { cost: event.properties.cost } : {}),
      }]

    default:
      return []
  }
}

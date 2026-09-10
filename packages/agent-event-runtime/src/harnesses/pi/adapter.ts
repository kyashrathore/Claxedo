import type { AgentRuntimeEvent } from "../../contracts/agent-runtime-event"
import type { HarnessEventAdapter } from "../../core/adapter"
import { object, text } from "../../value"
import { contentBlockImages } from "../tool-attachments"

/** Pi payload readers: absent or non-object fields read as empty rather than throwing. */
const row = (value: unknown): Record<string, unknown> => object(value) ?? {}
const string = (value: unknown) => text(value) ?? ""
type State = { blocks: Record<number, string>; finished: boolean }

/** The only Pi RPC → product event translation. No upstream model library enters the host. */
export function piRpcAdapter(): HarnessEventAdapter<State> {
  return {
    name: "pi-rpc",
    createInitialState: () => ({ blocks: {}, finished: false }),
    translate({ state, event, context }) {
      const message = row(event.payload)
      if (event.source === "pi.goal-evaluator") return message.type === "message_end" ? usageEvents(row(message.message).usage) : []
      const events: AgentRuntimeEvent[] = []
      switch (message.type) {
        case "extension_ui_request":
          if (!["select", "confirm", "input", "editor"].includes(string(message.method))) break
          if (typeof message.id !== "string") throw new Error("Pi question lacks its request id")
          return [
            {
              type: "question",
              requestId: message.id,
              questions: [
                {
                  text: string(message.title) || string(message.message) || "Pi extension",
                  options:
                    message.method === "confirm"
                      ? ["Yes", "No"]
                      : Array.isArray(message.options)
                        ? message.options.filter((value): value is string => typeof value === "string")
                        : undefined,
                },
              ],
            },
          ]
        case "agent_start":
          return { state: { blocks: {}, finished: false }, events: [] }
        case "message_start":
          if (row(message.message).role === "assistant") return { state: { ...state, blocks: {} }, events }
          break
        case "message_update": {
          const update = row(message.assistantMessageEvent)
          if (update.type !== "text_delta" && update.type !== "thinking_delta") break
          if (typeof update.contentIndex !== "number" || typeof update.delta !== "string")
            throw new Error("Invalid Pi content delta")
          const index = update.contentIndex
          return {
            state: { ...state, blocks: { ...state.blocks, [index]: (state.blocks[index] ?? "") + update.delta } },
            events: [{ type: update.type === "text_delta" ? "text-delta" : "thinking-delta", delta: update.delta }],
          }
        }
        case "message_end": {
          const assistant = row(message.message)
          if (assistant.role !== "assistant") break
          const content = Array.isArray(assistant.content) ? assistant.content : []
          content.forEach((item, index) => {
            const block = row(item)
            if (block.type !== "text" && block.type !== "thinking") return
            const value = string(block.type === "text" ? block.text : block.thinking)
            const prior = state.blocks[index] ?? ""
            if (!value.startsWith(prior)) throw new Error("Pi final content disagrees with streamed deltas")
            if (value.length > prior.length)
              events.push({
                type: block.type === "text" ? "text-delta" : "thinking-delta",
                delta: value.slice(prior.length),
              })
          })
          events.push(
            ...usageEvents(
              assistant.usage,
              typeof assistant.timestamp === "number" ? String(assistant.timestamp) : undefined,
            ),
          )
          if (assistant.stopReason === "error")
            events.push({ type: "error", error: string(assistant.errorMessage) || "Pi model request failed" })
          return { state: { ...state, blocks: {} }, events }
        }
        case "tool_execution_start":
          if (typeof message.toolCallId !== "string" || typeof message.toolName !== "string")
            throw new Error("Pi tool start lacks identity")
          return [
            { type: "tool-start", toolCallId: message.toolCallId, toolName: message.toolName },
            { type: "tool-input", toolCallId: message.toolCallId, input: message.args },
          ]
        case "tool_execution_end": {
          if (typeof message.toolCallId !== "string") throw new Error("Pi tool completion lacks identity")
          if (message.isError)
            return [{ type: "tool-error", toolCallId: message.toolCallId, error: JSON.stringify(message.result) }]
          const images = contentBlockImages(row(message.result).content)
          return [{
            type: "tool-output",
            toolCallId: message.toolCallId,
            output: message.result,
            ...(images.length ? { attachments: images } : {}),
          }]
        }
        case "auto_compaction_start":
        case "compaction_start":
          return [{ type: "session-compaction", phase: "started" }]
        case "auto_compaction_end":
        case "compaction_end":
          return [
            ...usageEvents(row(message.result).usage),
            {
              type: "session-compaction",
              phase: "completed",
              summary: string(row(message.result).summary) || undefined,
              metadata: {
                aborted: message.aborted === true,
                ...(typeof message.errorMessage === "string" ? { error: message.errorMessage } : {}),
              },
            },
          ]
        case "tool_execution_update": {
          const toolCallId = message.toolCallId
          if (typeof toolCallId !== "string") throw new Error("Pi tool update lacks identity")
          const partial = row(message.partialResult)
          const content = Array.isArray(partial.content) ? partial.content : []
          return content.flatMap((item) => {
            const block = row(item)
            return block.type === "text" && typeof block.text === "string"
              ? [
                  {
                    type: "tool-content" as const,
                    toolCallId,
                    content: { type: "content" as const, content: { type: "text" as const, text: block.text } },
                  },
                ]
              : []
          })
        }
        case "extension_notify":
          return [
            {
              type: "harness-notice",
              code: "pi.extension_notify",
              message: string(message.message),
              severity: message.notifyType === "error" ? "error" : message.notifyType === "warning" ? "warn" : "info",
            },
          ]
        case "auto_retry_start":
          return [
            {
              type: "harness-notice",
              code: "pi.retry",
              message: string(message.errorMessage) || "Pi is retrying the model request",
              severity: "warn",
            },
          ]
        case "extension_error":
          return [
            { type: "harness-notice", code: "pi.extension_error", message: string(message.error), severity: "error" },
          ]
        case "agent_settled":
          if (state.finished) break
          return { state: { ...state, finished: true }, events: [{ type: "finish", sessionId: context.threadId }] }
      }
      return events
    },
  }
}

/** Pi reports billable compaction work separately from assistant messages. */
function usageEvents(value: unknown, providerObservationId?: string): AgentRuntimeEvent[] {
  const usage = row(value)
  if (typeof usage.input !== "number" || typeof usage.output !== "number") return []
  const cacheRead = typeof usage.cacheRead === "number" ? usage.cacheRead : null
  const cacheWrite = typeof usage.cacheWrite === "number" ? usage.cacheWrite : null
  return [
    {
      type: "usage",
      contextSize: 0,
      contextUsed: usage.input + (cacheRead ?? 0) + (cacheWrite ?? 0),
      observation: {
        kind: "delta",
        ...(providerObservationId ? { providerObservationId } : {}),
        tokens: {
          input: usage.input,
          output: usage.output,
          reasoning: null,
          cache: { read: cacheRead, write: cacheWrite },
        },
      },
    },
  ]
}

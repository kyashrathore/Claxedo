import type { SDKMessage } from "@cursor/sdk"
import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import { asText as text } from "@claxedo/agent-runtime-contract"
import type { HarnessEventAdapterContext, HarnessEventAdapterResult } from "../../../translate/adapter"
import { RETAINED_WIRE_KEYS_MAX, boundKeyedRecord, own } from "../../../translate/value"
import { assertNever, diagnosticForEvent, unmappedSdkEvent } from "./frames"
import { isTerminalSdkStatus, statusEvents } from "./run-status"
import { pruneTurnState, type CursorSdkAdapterState } from "./state"
import { toolCompletedEvents } from "./tool-results"
import { ensureTool, isTodoTool, todosFromInput, toolInput } from "./tools"

function assistantText(message: Extract<SDKMessage, { type: "assistant" }>) {
  return message.message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("")
}

function toolBlocks(message: Extract<SDKMessage, { type: "assistant" }>) {
  return message.message.content.flatMap((block) => block.type === "tool_use" ? [block] : [])
}

export function translateSdkMessage(input: {
  state: CursorSdkAdapterState
  event: { source: string; method?: string; payload: unknown }
  context: HarnessEventAdapterContext
  message: SDKMessage
}): HarnessEventAdapterResult<CursorSdkAdapterState> | AgentRuntimeEvent[] {
  const state = input.state
  const event = input.event
  const context = input.context
  const message = input.message

  switch (message.type) {
        case "assistant": {
          const snapshot = assistantText(message)
          const previous = own(state.assistantTextByRunId, message.run_id) ?? ""
          const delta = snapshot.startsWith(previous)
            ? snapshot.slice(previous.length)
            : previous.endsWith(snapshot)
              ? ""
              : snapshot
          const toolResults = toolBlocks(message).reduce<{ state: CursorSdkAdapterState; events: AgentRuntimeEvent[] }>(
            (current, block) => {
              if (isTodoTool(block.name)) {
                const todos = todosFromInput(toolInput(block.input))
                return {
                  state: current.state,
                  events: [
                    ...current.events,
                    ...(todos.length ? [{ type: "todo-update", todos } satisfies AgentRuntimeEvent] : []),
                  ],
                }
              }
              const ensured = ensureTool({
                state: current.state,
                toolCallId: block.id,
                toolName: block.name,
                rawInput: toolInput(block.input),
              })
              return { state: ensured.state, events: [...current.events, ...ensured.events] }
            },
            { state, events: [] satisfies AgentRuntimeEvent[] },
          )
          return {
            state: {
              ...toolResults.state,
              assistantTextByRunId: boundKeyedRecord({ ...toolResults.state.assistantTextByRunId, [message.run_id]: snapshot || previous }, RETAINED_WIRE_KEYS_MAX),
            },
            events: [
              ...(delta ? [{ type: "text-delta", delta } satisfies AgentRuntimeEvent] : []),
              ...toolResults.events,
            ],
          }
        }

        case "thinking": {
          const previous = own(state.thinkingTextByRunId, message.run_id) ?? ""
          const delta = message.text.startsWith(previous)
            ? message.text.slice(previous.length)
            : previous.endsWith(message.text)
              ? ""
              : message.text
          return {
            state: {
              ...state,
              thinkingTextByRunId: boundKeyedRecord({ ...state.thinkingTextByRunId, [message.run_id]: message.text || previous }, RETAINED_WIRE_KEYS_MAX),
            },
            events: delta ? [{ type: "thinking-delta", delta } satisfies AgentRuntimeEvent] : [],
          }
        }

        case "tool_call": {
          const rawInput = toolInput(message.args)
          if (isTodoTool(message.name)) {
            const todos = todosFromInput(rawInput)
            return todos.length ? [{ type: "todo-update", todos }] : []
          }
          const status = message.status
          switch (status) {
            case "running": {
              const ensured = ensureTool({
                state,
                toolCallId: message.call_id,
                toolName: message.name,
                rawInput,
              })
              return {
                state: ensured.state,
                events: [
                  ...ensured.events,
                  { type: "tool-status", toolCallId: message.call_id, status: "running", display: ensured.display, metadata: { cursor: { itemType: ensured.kind, truncated: message.truncated } } },
                ],
              }
            }
            case "completed":
            case "error":
              return toolCompletedEvents({
                state,
                toolCallId: message.call_id,
                toolName: message.name,
                rawInput,
                result: message.result,
                isError: status === "error",
              })
            default:
              return assertNever(status)
          }
        }

        case "status": {
          const events = statusEvents(message, context)
          return isTerminalSdkStatus(message.status) ? { state: pruneTurnState(), events } : events
        }

        case "system":
          return [
            { type: "session-agent", agentId: message.agent_id },
            ...unmappedSdkEvent({
              sdkEvent: `SDKSystemMessage(${message.subtype ?? "unknown"})`,
              reason: "model and tool inventory have no complete AgentRuntimeEvent mapping",
              event,
            }),
          ]

        case "task": {
          const taskText = text(message.text)
          return taskText
            ? [diagnosticForEvent({
              code: "cursor_sdk.task_progress",
              message: taskText,
              severity: "info",
              event,
              details: { status: message.status },
            })]
            : []
        }

        case "request":
          return []

        case "usage":
          return [{
            type: "usage",
            contextSize: message.usage.totalTokens,
            contextUsed: message.usage.totalTokens,
            observation: {
              kind: "cumulative",
              providerObservationId: message.run_id,
              tokens: {
                input: message.usage.inputTokens,
                output: message.usage.outputTokens,
                reasoning: null,
                cache: {
                  read: message.usage.cacheReadTokens,
                  write: message.usage.cacheWriteTokens,
                },
              },
            },
          }]

        case "user":
          return []

        default:
          return assertNever(message)
      }
}

import type { NestedTaskUpdate, SDKMessage } from "@cursor/sdk"

type NestedTool = Extract<NestedTaskUpdate, { type: "tool-call-started" | "partial-tool-call" | "tool-call-completed" }>

function nestedToolMessage(update: NestedTool, ids: { agent_id: string; run_id: string }): SDKMessage {
  const call = update.toolCall as { type?: unknown; args?: unknown; result?: unknown }
  const status = update.type === "tool-call-completed" ? "completed" : "running"
  return { type: "tool_call", ...ids, call_id: update.callId, name: typeof call.type === "string" ? call.type : "unknown", status,
    ...(call.args === undefined ? {} : { args: call.args }), ...(call.result === undefined ? {} : { result: call.result }) }
}

export function nestedTaskMessage(update: NestedTaskUpdate, taskCallId: string): SDKMessage | undefined {
  const ids = { agent_id: taskCallId, run_id: taskCallId }
  switch (update.type) {
    case "text-delta":
      return { type: "assistant", ...ids, message: { role: "assistant", content: [{ type: "text", text: update.text }] } }
    case "thinking-delta":
      return { type: "thinking", ...ids, text: update.text }
    case "tool-call-started":
    case "partial-tool-call":
    case "tool-call-completed":
      return nestedToolMessage(update, ids)
    case "thinking-completed":
    case "step-started":
    case "step-completed":
    case "tool-requests-listed":
      return undefined
  }
}

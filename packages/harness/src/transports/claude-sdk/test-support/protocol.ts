import assert from "node:assert/strict"
import { isRecord } from "@claxedo/helpers/guards"
import { conforms, count, flag, json, list, oneOf, optional, text, type Shape } from "../../../test-support/wire-shape"

const isTextList = list(text)

const controlRequests: Record<string, Shape> = {
  initialize: { required: [], fields: {
    hooks: isRecord, jsonSchema: isRecord, toolAliases: isRecord, agents: isRecord,
    sdkMcpServers: isTextList, systemPrompt: isTextList, skills: isTextList, supportedDialogKinds: isTextList,
    appendSystemPrompt: text, planModeInstructions: text, title: text,
    excludeDynamicSections: flag, promptSuggestions: flag, agentProgressSummaries: flag, forwardSubagentText: flag,
  } },
  interrupt: { required: [], fields: { cancel_queued: optional(flag) } },
  set_permission_mode: { required: ["mode"], fields: { mode: oneOf("default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto") } },
  set_model: { required: [], fields: { model: optional(text) } },
  set_max_thinking_tokens: { required: [], fields: { max_thinking_tokens: optional(count), thinking_display: optional(oneOf("summarized", "omitted")) } },
}
const userMessage: Shape = { required: ["type", "message", "parent_tool_use_id"], fields: {
  type: text, message: isRecord, parent_tool_use_id: (value) => value === null || text(value), isSynthetic: optional(flag),
  tool_use_result: json, priority: optional(oneOf("now", "next", "later")), origin: optional(isRecord), shouldQuery: optional(flag),
  timestamp: optional(text), uuid: optional(text), session_id: optional(text), subagent_type: optional(text),
} }

export class ClaudePeer {
  private phase: "new" | "ready" | "running" | "completed" = "new"

  receive(frame: Record<string, unknown>): "initialize" | "control" | "user" {
    if (frame.type === "control_request") return this.control(frame)
    assert.equal(frame.type, "user", `Unscripted Claude frame: ${JSON.stringify(frame.type)}`)
    assert(this.phase === "ready" || this.phase === "running", "User input requires initialize and an open session")
    assert(conforms(frame, userMessage), `Invalid Claude user message: ${JSON.stringify(Object.keys(frame))}`)
    const message = frame.message as Record<string, unknown>
    assert(message.role === "user", "Expected a user message")
    assert(typeof message.content === "string" || Array.isArray(message.content), "Invalid user content")
    this.phase = "running"
    return "user"
  }

  complete() {
    assert.equal(this.phase, "running", "A result requires an active turn")
    this.phase = "completed"
  }

  private control(frame: Record<string, unknown>): "initialize" | "control" {
    assert.equal(typeof frame.request_id, "string", "Control request requires a request id")
    assert(isRecord(frame.request), "Control request requires an object")
    const { subtype, ...fields } = frame.request
    assert(controlRequests[String(subtype)], `Unscripted Claude control subtype: ${JSON.stringify(subtype)}`)
    assert(conforms(fields, controlRequests[String(subtype)]), `Invalid Claude ${String(subtype)} parameters: ${JSON.stringify(fields)}`)
    if (subtype !== "initialize") {
      assert.notEqual(this.phase, "new", `${String(subtype)} requires initialize`)
      return "control"
    }
    assert.equal(this.phase, "new", "initialize may occur only once")
    this.phase = "ready"
    return "initialize"
  }
}

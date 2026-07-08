import { describe, expect, spyOn, test } from "bun:test"
import { createAgentEventRuntime } from "../../core/runtime"
import type { RuntimeSnapshot } from "../../core/state"
import { createAcpEventTranslator, type AcpEventTranslatorState } from "./event-translator"

function runtime(
  client = "codex-acp",
  initialSnapshot?: RuntimeSnapshot<AcpEventTranslatorState>,
  options?: { preserveUserMessageChunks?: boolean },
) {
  return createAgentEventRuntime({
    harness: client,
    threadId: "thread-1",
    adapter: createAcpEventTranslator({ client, ...options }),
    clock: () => 0,
    createId: () => "id",
    ...(initialSnapshot ? { initialSnapshot } : {}),
  })
}

describe("createAcpEventTranslator", () => {
  test("emits assistant message boundaries and text deltas", () => {
    const agent = runtime()

    expect(agent.ingest({
      source: "acp.jsonrpc",
      method: "session/update",
      payload: {
        sessionUpdate: "agent_message_chunk",
        messageId: "message-1",
        content: { type: "text", text: "hello" },
      },
    }).events.map((event) => ({ type: event.type, ...("delta" in event ? { delta: event.delta } : {}) }))).toEqual([
      { type: "step-start" },
      { type: "text-delta", delta: "hello" },
    ])
  })

  test("preserves tool output evidence when a later rawOutput is null", () => {
    const agent = runtime()
    agent.ingest({
      source: "acp.jsonrpc",
      method: "session/update",
      payload: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "Terminal",
        kind: "execute",
        rawInput: { command: "printf hi" },
      },
    })
    agent.ingest({
      source: "acp.jsonrpc",
      method: "session/update",
      payload: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "in_progress",
        rawOutput: { stdout: "hi" },
      },
    })

    const events = agent.ingest({
      source: "acp.jsonrpc",
      method: "session/update",
      payload: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "completed",
        rawOutput: null,
      },
    }).events

    expect(events.find((event) => event.type === "tool-output")).toMatchObject({
      type: "tool-output",
      toolCallId: "tool-1",
      output: { stdout: "hi" },
    })
  })

  test("emits harness-neutral display fields for tool projection", () => {
    const agent = runtime()

    const events = agent.ingest({
      source: "acp.jsonrpc",
      method: "session/update",
      payload: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "Read src/index.ts",
        kind: "read",
        rawInput: { file_path: "src/index.ts" },
        locations: [{ path: "src/index.ts", line: 3 }],
      },
    }).events

    expect(events.find((event) => event.type === "tool-start")).toMatchObject({
      type: "tool-start",
      toolCallId: "tool-1",
      toolName: "read",
      display: {
        kind: "read",
        intent: "read",
        filePath: "src/index.ts",
        locations: [{ path: "src/index.ts", line: 3 }],
        input: { file_path: "src/index.ts" },
      },
    })
    expect(events.find((event) => event.type === "tool-input")).toMatchObject({
      type: "tool-input",
      display: {
        intent: "read",
        filePath: "src/index.ts",
      },
    })
  })

  test("restores active tool state before terminal updates", () => {
    const first = runtime()
    first.ingest({
      source: "acp.jsonrpc",
      method: "session/update",
      payload: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "Terminal",
        kind: "execute",
        rawInput: { command: "printf hi" },
      },
    })
    first.ingest({
      source: "acp.jsonrpc",
      method: "session/update",
      payload: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "in_progress",
        rawOutput: { stdout: "hi" },
      },
    })

    const restored = runtime("codex-acp", first.snapshot())
    const events = restored.ingest({
      source: "acp.jsonrpc",
      method: "session/update",
      payload: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "completed",
        rawOutput: null,
      },
    }).events

    expect(events.find((event) => event.type === "tool-output")).toMatchObject({
      type: "tool-output",
      toolCallId: "tool-1",
      output: { stdout: "hi" },
      metadata: {
        acp: {
          rawInput: {
            command: "printf hi",
          },
        },
      },
    })
    expect(restored.snapshot().adapterState.tools["tool-1"]?.status).toBe("completed")
  })

  test("routes todo tools to todo updates instead of tool cards", () => {
    const agent = runtime("claude-acp")

    expect(agent.ingest({
      source: "acp.jsonrpc",
      method: "session/update",
      payload: {
        sessionUpdate: "tool_call",
        toolCallId: "todo-1",
        title: "Update TODOs",
        rawInput: {
          todos: [{ content: "Ship runtime", status: "in_progress", priority: "high" }],
        },
      },
    }).events.map((event) => event.type)).toEqual(["todo-update"])
  })

  test("routes codex permission tools to permission requests", () => {
    const agent = runtime("codex-acp")

    expect(agent.ingest({
      source: "acp.jsonrpc",
      method: "session/update",
      payload: {
        sessionUpdate: "tool_call",
        toolCallId: "permission-1",
        title: "Permission",
        rawInput: { tool: "shell", reason: "needs access", scopes: ["/repo"] },
      },
    }).events.find((event) => event.type === "permission-request")).toMatchObject({
      type: "permission-request",
      requestId: "permission-1",
      tool: "shell",
      paths: ["/repo"],
    })
  })

  test("emits config updates without requiring an active prompt listener", () => {
    const agent = runtime()

    expect(agent.ingest({
      source: "acp.jsonrpc",
      method: "session/update",
      payload: {
        sessionUpdate: "config_option_update",
        configOptions: [{
          id: "model",
          name: "Model",
          type: "select",
          currentValue: "gpt-5",
          options: [{ value: "gpt-5", name: "GPT-5" }],
        }],
      },
    }).events).toMatchObject([{
      type: "config-update",
      options: [{
        id: "model",
        name: "Model",
        type: "select",
        currentValue: "gpt-5",
        selectOptions: [{ id: "gpt-5", name: "GPT-5" }],
      }],
    }])
  })

  test("returns ACP translator diagnostics as runtime diagnostic events", () => {
    const agent = runtime()

    const events = agent.ingest({
      source: "acp.jsonrpc",
      method: "session/update",
      payload: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "Tool",
        rawInput: 1,
      },
    }).events

    expect(events.some((event) =>
      event.type === "diagnostic" &&
      event.diagnostic.code === "acp.malformed_raw_input" &&
      event.raw?.payload &&
      typeof event.raw.payload === "object",
    )).toBe(true)
  })

  test("does not write ACP diagnostics to console", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    const info = spyOn(console, "info").mockImplementation(() => {})
    try {
      runtime().ingest({
        source: "acp.jsonrpc",
        method: "session/update",
        payload: {
          sessionUpdate: "tool_call",
          toolCallId: "tool-1",
          title: "Tool",
          rawInput: 1,
        },
      })

      expect(warn).not.toHaveBeenCalled()
      expect(info).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
      info.mockRestore()
    }
  })

  test("guards malformed message content without advancing message state", () => {
    const agent = runtime()

    const malformed = agent.ingest({
      source: "acp.jsonrpc",
      method: "session/update",
      payload: {
        sessionUpdate: "agent_message_chunk",
        messageId: "message-1",
        content: null,
      },
    })

    expect(malformed.events).toMatchObject([{
      type: "diagnostic",
      diagnostic: {
        code: "acp.malformed_content",
      },
    }])
    expect(agent.snapshot().adapterState.lastMessageId).toBeNull()
    expect(agent.ingest({
      source: "acp.jsonrpc",
      method: "session/update",
      payload: {
        sessionUpdate: "agent_message_chunk",
        messageId: "message-1",
        content: { type: "text", text: "hello" },
      },
    }).events.map((event) => event.type)).toEqual(["step-start", "text-delta"])

    expect(agent.ingest({
      source: "acp.jsonrpc",
      method: "session/update",
      payload: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text" },
      },
    }).events).toMatchObject([{
      type: "diagnostic",
      diagnostic: {
        code: "acp.malformed_content",
      },
    }])
  })

  test("guards malformed plan and config option payloads", () => {
    const agent = runtime()

    expect(agent.ingest({
      source: "acp.jsonrpc",
      method: "session/update",
      payload: {
        sessionUpdate: "plan",
        entries: null,
      },
    }).events).toMatchObject([{
      type: "diagnostic",
      diagnostic: {
        code: "acp.malformed_plan",
      },
    }])

    expect(agent.ingest({
      source: "acp.jsonrpc",
      method: "session/update",
      payload: {
        sessionUpdate: "config_option_update",
        configOptions: [{ id: "model", name: "Model", type: "select", currentValue: true }],
      },
    }).events).toMatchObject([{
      type: "diagnostic",
      diagnostic: {
        code: "acp.malformed_config_options",
      },
    }])
  })

  test("maps item-based ACP plan updates to todo updates", () => {
    const agent = runtime()

    expect(agent.ingest({
      source: "acp.jsonrpc",
      method: "session/update",
      payload: {
        sessionUpdate: "plan_update",
        plan: {
          id: "plan-1",
          type: "items",
          entries: [{ content: "Ship ACP 0.26", status: "in_progress", priority: "high" }],
        },
      },
    }).events).toMatchObject([{
      type: "todo-update",
      todos: [{
        id: "0",
        description: "Ship ACP 0.26",
        status: "in_progress",
        priority: "high",
      }],
    }])
  })

  test("suppresses ACP user message chunks by default because live prompts are handled upstream", () => {
    const agent = runtime()

    expect(agent.ingest({
      source: "acp.jsonrpc",
      method: "session/update",
      payload: {
        sessionUpdate: "user_message_chunk",
        messageId: "user-message-1",
        content: { type: "text", text: "from the user" },
      },
    }).events).toEqual([])
  })

  test("can preserve user message chunks as runtime events when explicitly requested", () => {
    const agent = runtime("codex-acp", undefined, { preserveUserMessageChunks: true })

    expect(agent.ingest({
      source: "acp.jsonrpc",
      method: "session/update",
      payload: {
        sessionUpdate: "user_message_chunk",
        messageId: "user-message-1",
        content: { type: "text", text: "from the user" },
      },
    }).events).toMatchObject([{
      type: "user-message-delta",
      messageId: "user-message-1",
      content: { type: "text", text: "from the user" },
    }])
  })

  test("preserves available commands and session info updates", () => {
    const agent = runtime()

    expect(agent.ingest({
      source: "acp.jsonrpc",
      method: "session/update",
      payload: {
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "create_plan", description: "Create a plan" }],
      },
    }).events).toMatchObject([{
      type: "available-commands-update",
      commands: [{ name: "create_plan", description: "Create a plan" }],
    }])
    expect(agent.ingest({
      source: "acp.jsonrpc",
      method: "session/update",
      payload: {
        sessionUpdate: "session_info_update",
        title: null,
        updatedAt: "2026-06-16T00:00:00.000Z",
      },
    }).events).toMatchObject([{
      type: "session-info",
      title: null,
      updatedAt: "2026-06-16T00:00:00.000Z",
    }])
  })

  test("emits tool status for pending and useful tool updates", () => {
    const agent = runtime()

    agent.ingest({
      source: "acp.jsonrpc",
      method: "session/update",
      payload: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "Read",
        kind: "read",
      },
    })

    expect(agent.ingest({
      source: "acp.jsonrpc",
      method: "session/update",
      payload: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "pending",
        locations: [{ path: "src/index.ts", line: 4 }],
      },
    }).events).toMatchObject([
      { type: "tool-status", toolCallId: "tool-1", status: "pending" },
      { type: "tool-location", toolCallId: "tool-1", locations: [{ path: "src/index.ts", line: 4 }] },
    ])

    expect(agent.ingest({
      source: "acp.jsonrpc",
      method: "session/update",
      payload: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        rawInput: { file_path: "src/index.ts" },
      },
    }).events.find((event) => event.type === "tool-status")).toMatchObject({
      type: "tool-status",
      toolCallId: "tool-1",
      status: "pending",
    })
  })

  test("preserves ACP tool content while keeping specialized diff and terminal events", () => {
    const agent = runtime()

    agent.ingest({
      source: "acp.jsonrpc",
      method: "session/update",
      payload: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "Tool",
        kind: "execute",
      },
    })

    const events = agent.ingest({
      source: "acp.jsonrpc",
      method: "session/update",
      payload: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        content: [
          { type: "content", content: { type: "text", text: "plain result" } },
          { type: "content", content: { type: "image", mimeType: "image/png", data: "iVBORw0" } },
          { type: "content", content: { type: "resource", resource: { uri: "file:///tmp/blob", blob: "AAAA", mimeType: "application/octet-stream" } } },
          { type: "diff", path: "src/index.ts", oldText: "old", newText: "new" },
          { type: "terminal", terminalId: "pty-1" },
        ],
      },
    }).events

    expect(events.filter((event) => event.type === "tool-content")).toHaveLength(5)
    expect(events.find((event) => event.type === "file-diff")).toMatchObject({
      type: "file-diff",
      path: "src/index.ts",
      oldText: "old",
      newText: "new",
    })
    expect(events.find((event) => event.type === "tool-terminal")).toMatchObject({
      type: "tool-terminal",
      terminalId: "pty-1",
    })
  })

  test("preserves assistant and thought resources with runtime-native events", () => {
    const agent = runtime()

    expect(agent.ingest({
      source: "acp.jsonrpc",
      method: "session/update",
      payload: {
        sessionUpdate: "agent_message_chunk",
        messageId: "message-1",
        content: { type: "resource", resource: { uri: "file:///tmp/blob", blob: "AAAA", mimeType: "application/octet-stream" } },
      },
    }).events.map((event) => event.type)).toEqual(["step-start", "resource-delta"])

    expect(agent.ingest({
      source: "acp.jsonrpc",
      method: "session/update",
      payload: {
        sessionUpdate: "agent_thought_chunk",
        messageId: "message-1",
        content: { type: "audio", mimeType: "audio/wav", data: "AAAA" },
      },
    }).events).toMatchObject([{
      type: "thinking-audio-delta",
      mimeType: "audio/wav",
      data: "AAAA",
    }])

    expect(agent.ingest({
      source: "acp.jsonrpc",
      method: "session/update",
      payload: {
        sessionUpdate: "agent_thought_chunk",
        messageId: "message-1",
        content: { type: "resource_link", uri: "file:///tmp/thought", name: "thought", mimeType: "text/plain" },
      },
    }).events).toMatchObject([{
      type: "thinking-resource-link-delta",
      uri: "file:///tmp/thought",
      name: "thought",
      mimeType: "text/plain",
    }])
  })

  test("classifies ACP switch_mode tools explicitly", () => {
    const agent = runtime()

    expect(agent.ingest({
      source: "acp.jsonrpc",
      method: "session/update",
      payload: {
        sessionUpdate: "tool_call",
        toolCallId: "switch-1",
        title: "Switch mode",
        kind: "switch_mode",
        rawInput: { mode: "plan" },
      },
    }).events.find((event) => event.type === "tool-start")).toMatchObject({
      type: "tool-start",
      toolCallId: "switch-1",
      display: {
        intent: "switch_mode",
        kind: "switch_mode",
        input: { mode: "plan" },
      },
    })
  })

  test("does not leak ACP diagnostics across runtime instances", () => {
    const first = runtime()
    const second = runtime()

    first.ingest({
      source: "acp.jsonrpc",
      method: "session/update",
      payload: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "Tool",
        rawInput: 1,
      },
    })

    expect(second.ingest({
      source: "acp.jsonrpc",
      method: "session/update",
      payload: {
        sessionUpdate: "agent_message_chunk",
        messageId: "message-1",
        content: { type: "text", text: "hello" },
      },
    }).events.map((event) => event.type)).toEqual(["step-start", "text-delta"])
  })
})

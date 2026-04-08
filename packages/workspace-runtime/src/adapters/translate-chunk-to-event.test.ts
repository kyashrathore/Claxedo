/**
 * Tests for translateChunkToEvent (Layer 2: UIMessageChunk → OpenCodeEvent[]).
 */

import { describe, it, expect } from "bun:test"
import type { UIMessageChunk } from "./index"
import { translateChunkToEvent, type ChunkToEventContext } from "./translate-chunk-to-event"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides?: Partial<ChunkToEventContext>): ChunkToEventContext {
  return {
    sessionId: "sess-1",
    directory: "/workspace",
    assistantMsgId: "asm-1",
    accumulatedText: "hello world",
    accumulatedThinkingText: "thinking...",
    toolNamesByCallId: {},
    partIdMap: {},
    toolInputsByCallId: {},
    toolMetadataByCallId: {},
    toolStatusByCallId: {},
    textPartSeq: 0,
    reasoningPartSeq: 0,
    splitText: false,
    splitReasoning: false,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// session-status
// ---------------------------------------------------------------------------

describe("session-status", () => {
  it("→ session.status event", () => {
    const chunk: UIMessageChunk = { type: "session-status", status: "idle" }
    const events = translateChunkToEvent(chunk, makeCtx())
    expect(events).toHaveLength(1)
    expect(events[0].payload.type).toBe("session.status")
    expect(events[0].payload.properties).toMatchObject({ sessionID: "sess-1", status: { type: "idle" } })
  })

  it("busy status", () => {
    const chunk: UIMessageChunk = { type: "session-status", status: "busy" }
    const events = translateChunkToEvent(chunk, makeCtx())
    expect(events[0].payload.properties).toMatchObject({ status: { type: "busy" } })
  })
})

// ---------------------------------------------------------------------------
// text-delta
// ---------------------------------------------------------------------------

describe("text-delta", () => {
  it("→ message.part.updated then message.part.delta", () => {
    const chunk: UIMessageChunk = { type: "text-delta", delta: "world" }
    const ctx = makeCtx({ accumulatedText: "hello world" })
    const events = translateChunkToEvent(chunk, ctx)
    expect(events).toHaveLength(2)
    expect(events[0].payload.type).toBe("message.part.updated")
    expect(events[0].payload.properties).toMatchObject({
      part: { type: "text", id: "000000_asm-1-text", text: "" },
    })
    expect(events[1].payload).toMatchObject({
      type: "message.part.delta",
      properties: {
        sessionID: "sess-1",
        messageID: "asm-1",
        partID: "000000_asm-1-text",
        field: "text",
        delta: "world",
      },
    })
  })

  it("starts a fresh text part after a tool chunk", () => {
    const ctx = makeCtx()
    translateChunkToEvent({ type: "text-delta", delta: "before" }, ctx)
    translateChunkToEvent({ type: "tool-start", toolCallId: "tc1", toolName: "Read" }, ctx)
    const events = translateChunkToEvent({ type: "text-delta", delta: "after" }, ctx)
    expect(events[0].payload.properties).toMatchObject({
      part: { type: "text", id: expect.stringContaining("asm-1-text-1"), text: "" },
    })
    expect(events[1].payload).toMatchObject({
      type: "message.part.delta",
      properties: { partID: expect.stringContaining("asm-1-text-1"), delta: "after" },
    })
  })
})

// ---------------------------------------------------------------------------
// thinking-delta
// ---------------------------------------------------------------------------

describe("thinking-delta", () => {
  it("→ message.part.updated then message.part.delta for reasoning", () => {
    const chunk: UIMessageChunk = { type: "thinking-delta", delta: "more" }
    const ctx = makeCtx({ accumulatedThinkingText: "thinking..." })
    const events = translateChunkToEvent(chunk, ctx)
    expect(events).toHaveLength(2)
    expect(events[0].payload.type).toBe("message.part.updated")
    expect(events[0].payload.properties).toMatchObject({
      part: { type: "reasoning", id: "000000_asm-1-reasoning", text: "" },
    })
    expect(events[1].payload).toMatchObject({
      type: "message.part.delta",
      properties: {
        sessionID: "sess-1",
        messageID: "asm-1",
        partID: "000000_asm-1-reasoning",
        field: "text",
        delta: "more",
      },
    })
  })
})

// ---------------------------------------------------------------------------
// tool-start
// ---------------------------------------------------------------------------

describe("tool-start", () => {
  it("→ message.part.updated type=tool running", () => {
    const chunk: UIMessageChunk = { type: "tool-start", toolCallId: "tc1", toolName: "Read file" }
    const events = translateChunkToEvent(chunk, makeCtx())
    expect(events).toHaveLength(1)
    expect(events[0].payload.properties).toMatchObject({
      part: { type: "tool", id: "000000_tc1", callID: "tc1", tool: "Read file", state: { status: "running" } },
    })
  })

  it("stores tool name as-is in context for subsequent chunks", () => {
    const ctx = makeCtx()
    const chunk: UIMessageChunk = { type: "tool-start", toolCallId: "tc1", toolName: "Read" }
    translateChunkToEvent(chunk, ctx)
    expect(ctx.toolNamesByCallId["tc1"]).toBe("Read")
  })

  it("without kind → no kind property on part", () => {
    const chunk: UIMessageChunk = { type: "tool-start", toolCallId: "tc1", toolName: "Read" }
    const events = translateChunkToEvent(chunk, makeCtx())
    expect((events[0].payload.properties as { part: Record<string, unknown> }).part.kind).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// tool-input
// ---------------------------------------------------------------------------

describe("tool-input", () => {
  it("→ message.part.updated type=tool running with input", () => {
    const ctx = makeCtx({ toolNamesByCallId: { tc1: "Read" } })
    const chunk: UIMessageChunk = { type: "tool-input", toolCallId: "tc1", input: { file: "foo.ts" } }
    const events = translateChunkToEvent(chunk, ctx)
    expect(events).toHaveLength(1)
    expect(events[0].payload.properties).toMatchObject({
      part: { type: "tool", id: "000000_tc1", tool: "Read", state: { status: "running", input: { file: "foo.ts" } } },
    })
  })

  it("empty {} input → [] (no event, avoids duplicate running state)", () => {
    const ctx = makeCtx({ toolNamesByCallId: { tc1: "Read" } })
    const chunk: UIMessageChunk = { type: "tool-input", toolCallId: "tc1", input: {} }
    expect(translateChunkToEvent(chunk, ctx)).toEqual([])
  })

  it("snake_case input keys are normalized to camelCase", () => {
    const ctx = makeCtx({ toolNamesByCallId: { tc1: "read" } })
    const chunk: UIMessageChunk = { type: "tool-input", toolCallId: "tc1", input: { file_path: "/src/foo.ts" } }
    const events = translateChunkToEvent(chunk, ctx)
    const part = (events[0].payload.properties as { part: Record<string, unknown> }).part
    const input = (part.state as Record<string, unknown>).input as Record<string, unknown>
    expect(input.filePath).toBe("/src/foo.ts")
    expect(input.file_path).toBe("/src/foo.ts") // original key preserved
  })

  it("stores normalized input in ctx.toolInputsByCallId", () => {
    const ctx = makeCtx({ toolNamesByCallId: { tc1: "Read" } })
    const chunk: UIMessageChunk = { type: "tool-input", toolCallId: "tc1", input: { file_path: "/foo.ts" } }
    translateChunkToEvent(chunk, ctx)
    expect(ctx.toolInputsByCallId["tc1"]).toMatchObject({ file_path: "/foo.ts", filePath: "/foo.ts" })
  })
})

// ---------------------------------------------------------------------------
// tool-output
// ---------------------------------------------------------------------------

describe("tool-output", () => {
  it("→ single event: type=tool completed with output", () => {
    const ctx = makeCtx({ toolNamesByCallId: { tc1: "Bash" } })
    const chunk: UIMessageChunk = { type: "tool-output", toolCallId: "tc1", output: "result data" }
    const events = translateChunkToEvent(chunk, ctx)
    expect(events).toHaveLength(1)
    expect(events[0].payload.properties).toMatchObject({
      part: { type: "tool", id: "000000_tc1", tool: "Bash", state: { status: "completed", output: "result data" } },
    })
  })

  it("preserves stored input from prior tool-input chunk", () => {
    const ctx = makeCtx({
      toolNamesByCallId: { tc1: "Read" },
      toolInputsByCallId: { tc1: { filePath: "/src/foo.ts", file_path: "/src/foo.ts" } },
    })
    const chunk: UIMessageChunk = { type: "tool-output", toolCallId: "tc1", output: "content" }
    const events = translateChunkToEvent(chunk, ctx)
    const state = ((events[0].payload.properties as { part: Record<string, unknown> }).part.state) as Record<string, unknown>
    expect(state.input).toMatchObject({ filePath: "/src/foo.ts" })
  })

  it("merges stored ACP metadata into the completed tool state", () => {
    const ctx = makeCtx({
      toolNamesByCallId: { tc1: "bash" },
      toolInputsByCallId: { tc1: { intent: "shell", command: "git status" } },
      toolMetadataByCallId: { tc1: { acp: { intent: "shell", terminalId: "term-1" } } },
    })
    const chunk: UIMessageChunk = {
      type: "tool-output",
      toolCallId: "tc1",
      output: "ok",
      metadata: { acp: { rawOutput: { exitCode: 0 } } },
    }
    const events = translateChunkToEvent(chunk, ctx)
    const state = ((events[0].payload.properties as { part: Record<string, unknown> }).part.state) as Record<string, unknown>
    expect(state.metadata).toMatchObject({ acp: { intent: "shell", terminalId: "term-1", rawOutput: { exitCode: 0 } } })
  })

  it("uses stdout and stderr from shell output objects instead of JSON", () => {
    const ctx = makeCtx({
      toolNamesByCallId: { tc1: "bash" },
      toolInputsByCallId: { tc1: { intent: "shell", command: "pwd" } },
      toolMetadataByCallId: { tc1: { acp: { intent: "shell" } } },
    })
    const chunk: UIMessageChunk = {
      type: "tool-output",
      toolCallId: "tc1",
      output: { exitCode: 0, stdout: "/workspace\n", stderr: "" },
    }
    const events = translateChunkToEvent(chunk, ctx)
    const state = ((events[0].payload.properties as { part: Record<string, unknown> }).part.state) as Record<string, unknown>
    expect(state.output).toBe("/workspace\n")
  })

  it("suppresses count-only JSON blobs in completed tool output", () => {
    const ctx = makeCtx({
      toolNamesByCallId: { tc1: "find" },
      toolInputsByCallId: { tc1: { intent: "list", mode: "files", summary: "Find" } },
      toolMetadataByCallId: { tc1: { acp: { intent: "list", mode: "files" } } },
    })
    const chunk: UIMessageChunk = {
      type: "tool-output",
      toolCallId: "tc1",
      output: { totalFiles: 126, truncated: false },
    }
    const events = translateChunkToEvent(chunk, ctx)
    const state = ((events[0].payload.properties as { part: Record<string, unknown> }).part.state) as Record<string, unknown>
    expect(state.output).toBe("")
  })

  it("suppresses diff-array JSON when diff parts are rendered separately", () => {
    const ctx = makeCtx({
      toolNamesByCallId: { tc1: "delete" },
      toolInputsByCallId: { tc1: { intent: "delete", filePath: "/workspace/tmp.txt" } },
      toolMetadataByCallId: { tc1: { acp: { intent: "delete", hasDiff: true } } },
    })
    const chunk: UIMessageChunk = {
      type: "tool-output",
      toolCallId: "tc1",
      output: [{ path: "/workspace/tmp.txt", oldText: "x", newText: "" }],
    }
    const events = translateChunkToEvent(chunk, ctx)
    const state = ((events[0].payload.properties as { part: Record<string, unknown> }).part.state) as Record<string, unknown>
    expect(state.output).toBe("")
  })
})

// ---------------------------------------------------------------------------
// tool-error
// ---------------------------------------------------------------------------

describe("tool-error", () => {
  it("→ single event: type=tool error state", () => {
    const ctx = makeCtx({ toolNamesByCallId: { tc1: "Bash" } })
    const chunk: UIMessageChunk = { type: "tool-error", toolCallId: "tc1", error: "Command failed" }
    const events = translateChunkToEvent(chunk, ctx)
    expect(events).toHaveLength(1)
    expect(events[0].payload.properties).toMatchObject({
      part: { type: "tool", id: "000000_tc1", tool: "Bash", state: { status: "error", error: "Command failed" } },
    })
  })

  it("preserves stored input from prior tool-input chunk", () => {
    const ctx = makeCtx({
      toolNamesByCallId: { tc1: "Bash" },
      toolInputsByCallId: { tc1: { command: "ls -la" } },
    })
    const chunk: UIMessageChunk = { type: "tool-error", toolCallId: "tc1", error: "Permission denied" }
    const events = translateChunkToEvent(chunk, ctx)
    const state = ((events[0].payload.properties as { part: Record<string, unknown> }).part.state) as Record<string, unknown>
    expect(state.input).toMatchObject({ command: "ls -la" })
  })
})

// ---------------------------------------------------------------------------
// file-diff
// ---------------------------------------------------------------------------

describe("file-diff", () => {
  it("→ message.part.updated with diff part", () => {
    const chunk: UIMessageChunk = { type: "file-diff", path: "src/foo.ts", oldText: "old", newText: "new" }
    const events = translateChunkToEvent(chunk, makeCtx())
    expect(events).toHaveLength(1)
    expect(events[0].payload.properties).toMatchObject({
      part: { type: "diff", path: "src/foo.ts", oldText: "old", newText: "new" },
    })
  })

  it("without oldText → diff part without oldText", () => {
    const chunk: UIMessageChunk = { type: "file-diff", path: "src/new.ts", newText: "new content" }
    const events = translateChunkToEvent(chunk, makeCtx())
    expect(events[0].payload.properties).toMatchObject({
      part: { type: "diff", path: "src/new.ts", newText: "new content" },
    })
  })
})

// ---------------------------------------------------------------------------
// step-start
// ---------------------------------------------------------------------------

describe("step-start", () => {
  it("→ message.completed for current assistantMsgId", () => {
    const chunk: UIMessageChunk = { type: "step-start", newMessageId: "asm-2" }
    const events = translateChunkToEvent(chunk, makeCtx())
    expect(events).toHaveLength(1)
    expect(events[0].payload.type).toBe("message.completed")
    expect(events[0].payload.properties).toMatchObject({
      sessionID: "sess-1",
      messageID: "asm-1", // the OLD assistant message ID
    })
  })
})

// ---------------------------------------------------------------------------
// finish
// ---------------------------------------------------------------------------

describe("finish", () => {
  it("→ message.completed then session.idle", () => {
    const chunk: UIMessageChunk = { type: "finish", sessionId: "sess-1" }
    const events = translateChunkToEvent(chunk, makeCtx())
    expect(events).toHaveLength(2)
    expect(events[0].payload.type).toBe("message.completed")
    expect(events[0].payload.properties).toMatchObject({
      sessionID: "sess-1",
      messageID: "asm-1",
    })
    expect(events[1].payload.type).toBe("session.idle")
    expect(events[1].payload.properties).toMatchObject({ sessionID: "sess-1" })
  })
})

// ---------------------------------------------------------------------------
// error
// ---------------------------------------------------------------------------

describe("error", () => {
  it("→ session.error", () => {
    const chunk: UIMessageChunk = { type: "error", error: "Something failed" }
    const events = translateChunkToEvent(chunk, makeCtx())
    expect(events).toHaveLength(1)
    expect(events[0].payload.type).toBe("session.error")
    expect(events[0].payload.properties).toMatchObject({
      sessionID: "sess-1",
      error: { name: "UnknownError", data: { message: "Something failed" } },
    })
  })
})

// ---------------------------------------------------------------------------
// permission-request
// ---------------------------------------------------------------------------

describe("permission-request", () => {
  it("→ permission.asked", () => {
    const chunk: UIMessageChunk = {
      type: "permission-request",
      requestId: "perm-1",
      tool: "bash",
      paths: ["/tmp"],
    }
    const events = translateChunkToEvent(chunk, makeCtx())
    expect(events).toHaveLength(1)
    expect(events[0].payload.type).toBe("permission.asked")
    expect(events[0].payload.properties).toMatchObject({
      id: "perm-1",
      sessionID: "sess-1",
      permission: "bash",
      patterns: ["/tmp"],
      metadata: {},
      always: ["/tmp"],
    })
  })
})

// ---------------------------------------------------------------------------
// question
// ---------------------------------------------------------------------------

describe("question", () => {
  it("→ question.asked", () => {
    const chunk: UIMessageChunk = {
      type: "question",
      requestId: "q-1",
      questions: [{ text: "Are you sure?", options: ["yes", "no"] }],
    }
    const events = translateChunkToEvent(chunk, makeCtx())
    expect(events).toHaveLength(1)
    expect(events[0].payload.type).toBe("question.asked")
  })
})

// ---------------------------------------------------------------------------
// todo-update
// ---------------------------------------------------------------------------

describe("todo-update", () => {
  it("→ todo.updated and session.todo", () => {
    const chunk: UIMessageChunk = {
      type: "todo-update",
      todos: [{ id: "0", description: "Do thing", status: "pending", priority: "high" }],
    }
    const events = translateChunkToEvent(chunk, makeCtx())
    expect(events).toHaveLength(2)
    expect(events[0].payload.type).toBe("todo.updated")
    expect(events[0].payload.properties).toMatchObject({ sessionID: "sess-1" })
    expect(events[1].payload.type).toBe("session.todo")
    expect(events[1].payload.properties).toMatchObject({ sessionID: "sess-1" })
  })
})

// ---------------------------------------------------------------------------
// image-delta
// ---------------------------------------------------------------------------

describe("image-delta", () => {
  it("→ message.part.updated with image part", () => {
    const chunk: UIMessageChunk = { type: "image-delta", mimeType: "image/png", data: "base64" }
    const events = translateChunkToEvent(chunk, makeCtx())
    expect(events).toHaveLength(1)
    expect(events[0].payload.properties).toMatchObject({
      part: { type: "image", mimeType: "image/png", data: "base64" },
    })
  })
})

// ---------------------------------------------------------------------------
// audio-delta
// ---------------------------------------------------------------------------

describe("audio-delta", () => {
  it("→ message.part.updated with audio part", () => {
    const chunk: UIMessageChunk = { type: "audio-delta", mimeType: "audio/mp3", data: "adata" }
    const events = translateChunkToEvent(chunk, makeCtx())
    expect(events).toHaveLength(1)
    expect(events[0].payload.properties).toMatchObject({
      part: { type: "audio", mimeType: "audio/mp3", data: "adata" },
    })
  })
})

// ---------------------------------------------------------------------------
// resource-link-delta
// ---------------------------------------------------------------------------

describe("resource-link-delta", () => {
  it("→ message.part.updated with resource-link part", () => {
    const chunk: UIMessageChunk = {
      type: "resource-link-delta",
      uri: "file:///foo.ts",
      name: "foo.ts",
      mimeType: "text/plain",
    }
    const events = translateChunkToEvent(chunk, makeCtx())
    expect(events).toHaveLength(1)
    expect(events[0].payload.properties).toMatchObject({
      part: { type: "resource-link", uri: "file:///foo.ts", name: "foo.ts" },
    })
  })
})

// ---------------------------------------------------------------------------
// tool-location
// ---------------------------------------------------------------------------

describe("tool-location", () => {
  it("→ message.part.updated tool-use with locations", () => {
    const chunk: UIMessageChunk = {
      type: "tool-location",
      toolCallId: "tc1",
      locations: [{ path: "src/foo.ts", line: 42 }],
    }
    const events = translateChunkToEvent(chunk, makeCtx())
    expect(events).toHaveLength(1)
    expect(events[0].payload.properties).toMatchObject({
      part: {
        type: "tool",
        id: "000000_tc1",
        state: { metadata: { acp: { locations: [{ path: "src/foo.ts", line: 42 }] } } },
      },
    })
  })

  it("hydrates read input from locations when filePath is missing", () => {
    const ctx = makeCtx({ toolNamesByCallId: { tc1: "read" } })
    const chunk: UIMessageChunk = {
      type: "tool-location",
      toolCallId: "tc1",
      locations: [{ path: "src/foo.ts", line: 42 }],
    }
    const events = translateChunkToEvent(chunk, ctx)
    expect(events[0].payload.properties).toMatchObject({
      part: { state: { input: { filePath: "src/foo.ts" } } },
    })
    expect(ctx.toolInputsByCallId.tc1).toMatchObject({ filePath: "src/foo.ts" })
  })
})

// ---------------------------------------------------------------------------
// tool-terminal
// ---------------------------------------------------------------------------

describe("tool-terminal", () => {
  it("→ tool metadata update plus terminal part", () => {
    const chunk: UIMessageChunk = { type: "tool-terminal", toolCallId: "tc1", terminalId: "term-1" }
    const events = translateChunkToEvent(chunk, makeCtx())
    expect(events).toHaveLength(2)
    expect(events[0].payload.properties).toMatchObject({
      part: { type: "tool", id: "000000_tc1", state: { metadata: { acp: { terminalId: "term-1" } } } },
    })
    expect(events[1].payload.properties).toMatchObject({
      part: { type: "terminal", id: expect.stringContaining("tc1-terminal"), ptyId: "term-1" },
    })
  })
})

// ---------------------------------------------------------------------------
// session-agent
// ---------------------------------------------------------------------------

describe("session-agent", () => {
  it("→ session.agent event", () => {
    const chunk: UIMessageChunk = { type: "session-agent", agentId: "plan" }
    const events = translateChunkToEvent(chunk, makeCtx())
    expect(events).toHaveLength(1)
    expect(events[0].payload.type).toBe("session.agent")
    expect(events[0].payload.properties).toMatchObject({ sessionID: "sess-1", agentId: "plan" })
  })
})

// ---------------------------------------------------------------------------
// config-update
// ---------------------------------------------------------------------------

describe("config-update", () => {
  it("→ session.config event", () => {
    const chunk: UIMessageChunk = {
      type: "config-update",
      options: [{ id: "model", name: "Model", type: "select", currentValue: "claude-4" }],
    }
    const events = translateChunkToEvent(chunk, makeCtx())
    expect(events).toHaveLength(1)
    expect(events[0].payload.type).toBe("session.config")
    expect(events[0].payload.properties).toMatchObject({
      sessionID: "sess-1",
      options: [{ id: "model", type: "select" }],
    })
  })
})

// ---------------------------------------------------------------------------
// session-title
// ---------------------------------------------------------------------------

describe("session-title", () => {
  it("→ session.updated event with title", () => {
    const chunk: UIMessageChunk = { type: "session-title", title: "New session name" }
    const events = translateChunkToEvent(chunk, makeCtx())
    expect(events).toHaveLength(1)
    expect(events[0].payload.type).toBe("session.updated")
    expect(events[0].payload.properties).toMatchObject({
      info: {
        id: "sess-1",
        title: "New session name",
        projectID: "/workspace",
      },
    })
  })
})

// ---------------------------------------------------------------------------
// usage
// ---------------------------------------------------------------------------

describe("usage", () => {
  it("→ session.usage event", () => {
    const chunk: UIMessageChunk = { type: "usage", contextSize: 200000, contextUsed: 45000 }
    const events = translateChunkToEvent(chunk, makeCtx())
    expect(events).toHaveLength(1)
    expect(events[0].payload.type).toBe("session.usage")
    expect(events[0].payload.properties).toMatchObject({
      sessionID: "sess-1",
      contextSize: 200000,
      contextUsed: 45000,
    })
  })

  it("with cost → session.usage includes cost", () => {
    const chunk: UIMessageChunk = {
      type: "usage",
      contextSize: 100000,
      contextUsed: 30000,
      cost: { amount: 0.05, currency: "USD" },
    }
    const events = translateChunkToEvent(chunk, makeCtx())
    expect(events[0].payload.properties).toMatchObject({ cost: { amount: 0.05, currency: "USD" } })
  })
})

// ---------------------------------------------------------------------------
// subagent-spawned
// ---------------------------------------------------------------------------

describe("subagent-spawned", () => {
  it("→ [] (no event)", () => {
    const chunk: UIMessageChunk = { type: "subagent-spawned", childSessionId: "child-1" }
    expect(translateChunkToEvent(chunk, makeCtx())).toEqual([])
  })
})

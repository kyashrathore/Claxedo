/**
 * Tests for translateSessionUpdate (Layer 1: ACP SessionUpdate → UIMessageChunk[]).
 * All inputs are typed as real SDK types — SDK field renames break tests at compile time.
 */

import { describe, it, expect, beforeEach } from "bun:test"
import type { SessionUpdate } from "@agentclientprotocol/sdk"
import {
  translateSessionUpdate,
  translateStopReason,
  createTranslatorContext,
  type TranslatorContext,
} from "./translate-session-update"
import { viewTool } from "./acp-state"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ctx(client?: string): TranslatorContext {
  return createTranslatorContext(client)
}

function eventMeta(result: ReturnType<typeof translateSessionUpdate>, idx: number) {
  const event = result[idx] as { metadata?: Record<string, unknown> }
  return event.metadata?.acp as Record<string, unknown> | undefined
}

// ---------------------------------------------------------------------------
// agent_message_chunk
// ---------------------------------------------------------------------------

describe("agent_message_chunk", () => {
  it("text → text-delta", () => {
    const update: SessionUpdate = {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hello" },
    }
    const result = translateSessionUpdate(update, ctx())
    expect(result).toEqual([{ type: "text-delta", delta: "hello" }])
  })

  it("text empty string → text-delta with empty delta", () => {
    // Regression: old code had `&& content.text` which dropped empty strings
    const update: SessionUpdate = {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "" },
    }
    const result = translateSessionUpdate(update, ctx())
    expect(result).toEqual([{ type: "text-delta", delta: "" }])
  })

  it("image → image-delta", () => {
    const update: SessionUpdate = {
      sessionUpdate: "agent_message_chunk",
      content: { type: "image", data: "base64data", mimeType: "image/png" },
    }
    const result = translateSessionUpdate(update, ctx())
    expect(result).toEqual([{ type: "image-delta", mimeType: "image/png", data: "base64data" }])
  })

  it("audio → audio-delta", () => {
    const update: SessionUpdate = {
      sessionUpdate: "agent_message_chunk",
      content: { type: "audio", data: "audiodata", mimeType: "audio/mp3" },
    }
    const result = translateSessionUpdate(update, ctx())
    expect(result).toEqual([{ type: "audio-delta", mimeType: "audio/mp3", data: "audiodata" }])
  })

  it("resource_link → resource-link-delta", () => {
    const update: SessionUpdate = {
      sessionUpdate: "agent_message_chunk",
      content: { type: "resource_link", uri: "file:///foo.ts", name: "foo.ts", mimeType: "text/plain", title: "Foo" },
    }
    const result = translateSessionUpdate(update, ctx())
    expect(result).toEqual([{
      type: "resource-link-delta",
      uri: "file:///foo.ts",
      name: "foo.ts",
      mimeType: "text/plain",
      title: "Foo",
    }])
  })

  it("resource (TextResourceContents) → text-delta", () => {
    const update: SessionUpdate = {
      sessionUpdate: "agent_message_chunk",
      content: { type: "resource", resource: { uri: "file:///foo.ts", text: "file content" } },
    }
    const result = translateSessionUpdate(update, ctx())
    expect(result).toEqual([{ type: "text-delta", delta: "file content" }])
  })

  it("resource (BlobResourceContents) → dropped", () => {
    const update: SessionUpdate = {
      sessionUpdate: "agent_message_chunk",
      content: { type: "resource", resource: { uri: "file:///img.png", blob: "base64" } },
    }
    const result = translateSessionUpdate(update, ctx())
    expect(result).toEqual([])
  })

  it("first call, no messageId → no step-start", () => {
    const update: SessionUpdate = {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hi" },
      // messageId omitted (undefined)
    }
    const result = translateSessionUpdate(update, ctx())
    expect(result).not.toContainEqual(expect.objectContaining({ type: "step-start" }))
    expect(result).toEqual([{ type: "text-delta", delta: "hi" }])
  })

  it("same messageId on second call → no step-start", () => {
    const c = ctx()
    const update: SessionUpdate = {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "chunk1" },
      messageId: "msg-abc",
    }
    translateSessionUpdate(update, c)
    const result = translateSessionUpdate({ ...update, content: { type: "text", text: "chunk2" } }, c)
    expect(result).toEqual([{ type: "text-delta", delta: "chunk2" }])
  })

  it("messageId changes → step-start with newMessageId prepended", () => {
    const c = ctx()
    const first: SessionUpdate = {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "msg1" },
      messageId: "msg-001",
    }
    translateSessionUpdate(first, c)

    const second: SessionUpdate = {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "msg2" },
      messageId: "msg-002",
    }
    const result = translateSessionUpdate(second, c)
    expect(result).toEqual([
      { type: "step-start", newMessageId: "msg-002" },
      { type: "text-delta", delta: "msg2" },
    ])
  })
})

// ---------------------------------------------------------------------------
// agent_thought_chunk
// ---------------------------------------------------------------------------

describe("agent_thought_chunk", () => {
  it("text → thinking-delta", () => {
    const update: SessionUpdate = {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "reasoning..." },
    }
    expect(translateSessionUpdate(update, ctx())).toEqual([{ type: "thinking-delta", delta: "reasoning..." }])
  })

  it("text empty string → thinking-delta with empty delta", () => {
    const update: SessionUpdate = {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "" },
    }
    expect(translateSessionUpdate(update, ctx())).toEqual([{ type: "thinking-delta", delta: "" }])
  })

  it("image → image-delta", () => {
    const update: SessionUpdate = {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "image", data: "idata", mimeType: "image/jpeg" },
    }
    expect(translateSessionUpdate(update, ctx())).toEqual([{ type: "image-delta", mimeType: "image/jpeg", data: "idata" }])
  })

  it("non-image/non-text → dropped", () => {
    const update: SessionUpdate = {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "audio", data: "ad", mimeType: "audio/mp3" },
    }
    expect(translateSessionUpdate(update, ctx())).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// user_message_chunk
// ---------------------------------------------------------------------------

describe("user_message_chunk", () => {
  it("any content → empty array", () => {
    const update: SessionUpdate = {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "user says hi" },
    }
    expect(translateSessionUpdate(update, ctx())).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// tool_call
// ---------------------------------------------------------------------------

describe("tool_call", () => {
  it("minimal (no rawInput, no content, no locations) → [tool-start, normalized tool-input]", () => {
    const update: SessionUpdate = {
      sessionUpdate: "tool_call",
      toolCallId: "tc1",
      title: "Read file",
    }
    expect(translateSessionUpdate(update, ctx())).toMatchObject([
      { type: "tool-start", toolCallId: "tc1", toolName: "read", kind: undefined },
      { type: "tool-input", toolCallId: "tc1", input: { intent: "generic", summary: "Read file" } },
    ])
  })

  it("with kind → tool-start carries kind", () => {
    const update: SessionUpdate = {
      sessionUpdate: "tool_call",
      toolCallId: "tc1",
      title: "Read file",
      kind: "read",
    }
    const result = translateSessionUpdate(update, ctx())
    expect(result[0]).toMatchObject({ type: "tool-start", kind: "read" })
  })

  it("title with absolute path → [tool-start(lowercased), tool-input(synthetic)]", () => {
    const update: SessionUpdate = {
      sessionUpdate: "tool_call",
      toolCallId: "tc1",
      title: "Read /home/user/README.md",
      kind: "read",
    }
    const result = translateSessionUpdate(update, ctx())
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ type: "tool-start", toolName: "read" })
    expect(result[1]).toMatchObject({ type: "tool-input", toolCallId: "tc1", input: { filePath: "/home/user/README.md" } })
  })

  it("title with relative path + kind=read → synthetic filePath input (ACP agents use relative paths)", () => {
    const update: SessionUpdate = {
      sessionUpdate: "tool_call",
      toolCallId: "tc1",
      title: "Read README.md",
      kind: "read",
    }
    const result = translateSessionUpdate(update, ctx())
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ type: "tool-start", toolName: "read" })
    expect(result[1]).toMatchObject({ type: "tool-input", toolCallId: "tc1", input: { filePath: "README.md" } })
  })

  it("title with relative nested path + kind=read → synthetic filePath input", () => {
    const update: SessionUpdate = {
      sessionUpdate: "tool_call",
      toolCallId: "tc1",
      title: "Read packages/app/src/context/global-sdk.tsx",
      kind: "read",
    }
    const result = translateSessionUpdate(update, ctx())
    expect(result).toHaveLength(2)
    expect(result[1]).toMatchObject({ type: "tool-input", toolCallId: "tc1", input: { filePath: "packages/app/src/context/global-sdk.tsx" } })
  })

  it("title with relative path + no kind → generic normalized input without synthetic filePath", () => {
    const update: SessionUpdate = {
      sessionUpdate: "tool_call",
      toolCallId: "tc1",
      title: "Read README.md",
      // no kind
    }
    const result = translateSessionUpdate(update, ctx())
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ type: "tool-start", toolName: "read" })
    expect(result[1]).toMatchObject({ type: "tool-input", input: { intent: "generic", summary: "Read README.md" } })
  })

  it("title with non-path suffix → generic normalized input", () => {
    const update: SessionUpdate = {
      sessionUpdate: "tool_call",
      toolCallId: "tc1",
      title: "Read File",
    }
    const result = translateSessionUpdate(update, ctx())
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ type: "tool-start", toolName: "read" })
    expect(result[1]).toMatchObject({ type: "tool-input", input: { intent: "generic", summary: "Read File" } })
  })

  it("'Terminal' → shortName normalised to 'bash' with generic normalized input", () => {
    const update: SessionUpdate = {
      sessionUpdate: "tool_call",
      toolCallId: "tc1",
      title: "Terminal",
    }
    const result = translateSessionUpdate(update, ctx())
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ type: "tool-start", toolName: "bash" })
    expect(result[1]).toMatchObject({ type: "tool-input", input: { intent: "generic", summary: "Terminal" } })
  })

  it("'Terminal ls /' with execute kind → bash + command synthetic input (no path prefix needed)", () => {
    const update: SessionUpdate = {
      sessionUpdate: "tool_call",
      toolCallId: "tc1",
      title: "Terminal ls /",
      kind: "execute",
    }
    const result = translateSessionUpdate(update, ctx())
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ type: "tool-start", toolName: "bash" })
    expect(result[1]).toMatchObject({ type: "tool-input", toolCallId: "tc1", input: { command: "ls /", description: "ls /" } })
  })

  it("'Bash ls -la' with execute kind → bash + command (non-path command)", () => {
    const update: SessionUpdate = {
      sessionUpdate: "tool_call",
      toolCallId: "tc1",
      title: "Bash ls -la",
      kind: "execute",
    }
    const result = translateSessionUpdate(update, ctx())
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ type: "tool-start", toolName: "bash" })
    expect(result[1]).toMatchObject({ type: "tool-input", input: { command: "ls -la", description: "ls -la" } })
  })

  it("execute rawInput with shell argv → bash + normalized command text", () => {
    const update: SessionUpdate = {
      sessionUpdate: "tool_call",
      toolCallId: "tc1",
      title: "Run git branch -a",
      kind: "execute",
      rawInput: {
        command: ["/bin/zsh", "-lc", "git branch -a"],
        parsed_cmd: [{ type: "unknown", cmd: "git branch -a" }],
      },
    }
    const result = translateSessionUpdate(update, ctx())
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ type: "tool-start", toolName: "bash" })
    expect(result[1]).toMatchObject({
      type: "tool-input",
      toolCallId: "tc1",
      input: {
        command: "git branch -a",
        parsed_cmd: [{ type: "unknown", cmd: "git branch -a" }],
        description: "git branch -a",
      },
    })
  })

  it("title with path + kind=execute → command key (not filePath)", () => {
    const update: SessionUpdate = {
      sessionUpdate: "tool_call",
      toolCallId: "tc1",
      title: "Bash /bin/ls",
      kind: "execute",
    }
    const result = translateSessionUpdate(update, ctx())
    expect(result[1]).toMatchObject({ type: "tool-input", input: { command: "/bin/ls", description: "/bin/ls" } })
  })

  it("rawInput with data → used instead of synthetic", () => {
    const update: SessionUpdate = {
      sessionUpdate: "tool_call",
      toolCallId: "tc1",
      title: "Read /ignored/path",
      kind: "read",
      rawInput: { filePath: "/actual/path.ts" },
    }
    const result = translateSessionUpdate(update, ctx())
    expect(result).toHaveLength(2)
    expect(result[1]).toMatchObject({ type: "tool-input", toolCallId: "tc1", input: { filePath: "/actual/path.ts" } })
  })

  it("rawInput={} (empty object) → falls through to synthetic input from title", () => {
    const update: SessionUpdate = {
      sessionUpdate: "tool_call",
      toolCallId: "tc1",
      title: "Read /home/user/foo.ts",
      kind: "read",
      rawInput: {},
    }
    const result = translateSessionUpdate(update, ctx())
    expect(result).toHaveLength(2)
    expect(result[1]).toMatchObject({ type: "tool-input", toolCallId: "tc1", input: { filePath: "/home/user/foo.ts" } })
  })

  it("rawInput with falsy non-object values (0, false, null, '') → generic normalized tool-input", () => {
    for (const rawInput of [0, false, null, ""]) {
      const update: SessionUpdate = {
        sessionUpdate: "tool_call",
        toolCallId: "tc1",
        title: "Tool",
        rawInput,
      }
      const result = translateSessionUpdate(update, ctx())
      expect(result).toHaveLength(2)
      expect(result[0].type).toBe("tool-start")
      expect(result[1]).toMatchObject({ type: "tool-input", input: { intent: "generic", summary: "Tool" } })
    }
  })

  it("rawInput with keyed object → emitted as tool-input", () => {
    const update: SessionUpdate = {
      sessionUpdate: "tool_call",
      toolCallId: "tc1",
      title: "Tool",
      rawInput: { key: "value" },
    }
    const result = translateSessionUpdate(update, ctx())
    expect(result).toHaveLength(2)
    expect(result[1]).toMatchObject({ type: "tool-input", toolCallId: "tc1", input: { key: "value" } })
  })

  it("search rawInput with parsed command → grep + pattern/path", () => {
    const update: SessionUpdate = {
      sessionUpdate: "tool_call",
      toolCallId: "tc1",
      title: "Search sessionID in components",
      kind: "search",
      rawInput: {
        parsed_cmd: [{ type: "search", cmd: "git grep sessionID", query: "sessionID", path: "components" }],
      },
    }
    const result = translateSessionUpdate(update, ctx())
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ type: "tool-start", toolName: "grep" })
    expect(result[1]).toMatchObject({
      type: "tool-input",
      toolCallId: "tc1",
      input: {
        parsed_cmd: [{ type: "search", cmd: "git grep sessionID", query: "sessionID", path: "components" }],
        pattern: "sessionID",
        path: "components",
      },
    })
  })

  it("search rawInput with list_files and search → grep wins over generic title token", () => {
    const update: SessionUpdate = {
      sessionUpdate: "tool_call",
      toolCallId: "tc1",
      title: "List ., Search claxedo-app",
      kind: "search",
      rawInput: {
        parsed_cmd: [
          { type: "list_files", cmd: "rg --files .", path: "." },
          { type: "search", cmd: "rg 'claxedo-app' .", query: "claxedo-app", path: "." },
        ],
      },
    }
    const result = translateSessionUpdate(update, ctx())
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ type: "tool-start", toolName: "grep" })
    expect(result[1]).toMatchObject({
      type: "tool-input",
      toolCallId: "tc1",
      input: {
        parsed_cmd: [
          { type: "list_files", cmd: "rg --files .", path: "." },
          { type: "search", cmd: "rg 'claxedo-app' .", query: "claxedo-app", path: "." },
        ],
        pattern: "claxedo-app",
        path: ".",
      },
    })
  })

  it("bare Find search → list intent without fake grep shape", () => {
    const update: SessionUpdate = {
      sessionUpdate: "tool_call",
      toolCallId: "tc1",
      title: "Find",
      kind: "search",
      rawInput: {},
    }
    const result = translateSessionUpdate(update, ctx())
    expect(result[0]).toMatchObject({ type: "tool-start", toolName: "find" })
    expect(result[1]).toMatchObject({
      type: "tool-input",
      input: { intent: "list", mode: "files", summary: "Find" },
      metadata: { acp: { intent: "list", mode: "files" } },
    })
  })

  it("bare Web Search → search intent with web mode", () => {
    const update: SessionUpdate = {
      sessionUpdate: "tool_call",
      toolCallId: "tc1",
      title: "Web Search",
      kind: "search",
      rawInput: {},
    }
    const result = translateSessionUpdate(update, ctx())
    expect(result[1]).toMatchObject({
      type: "tool-input",
      input: { intent: "search", mode: "web", summary: "Web Search" },
      metadata: { acp: { intent: "search", mode: "web" } },
    })
  })

  it("bare Codebase Search → search intent with codebase mode", () => {
    const update: SessionUpdate = {
      sessionUpdate: "tool_call",
      toolCallId: "tc1",
      title: "Codebase Search",
      kind: "search",
      rawInput: {},
    }
    const result = translateSessionUpdate(update, ctx())
    expect(result[1]).toMatchObject({
      type: "tool-input",
      input: { intent: "search", mode: "codebase", summary: "Codebase Search" },
      metadata: { acp: { intent: "search", mode: "codebase" } },
    })
  })

  it("fetch rawInput with url → fetch intent metadata and url input", () => {
    const update: SessionUpdate = {
      sessionUpdate: "tool_call",
      toolCallId: "tc1",
      title: "Fetch https://example.com",
      kind: "fetch",
      rawInput: { url: "https://example.com" },
    }
    const result = translateSessionUpdate(update, ctx())
    expect(result[0]).toMatchObject({ type: "tool-start", toolName: "webfetch" })
    expect(result[1]).toMatchObject({
      type: "tool-input",
      input: { intent: "fetch", mode: "web", url: "https://example.com" },
      metadata: { acp: { intent: "fetch", mode: "web" } },
    })
  })

  it("move rawInput → move intent with source and target paths", () => {
    const update: SessionUpdate = {
      sessionUpdate: "tool_call",
      toolCallId: "tc1",
      title: "Move src/old.ts to src/new.ts",
      kind: "move",
      rawInput: { fromPath: "src/old.ts", toPath: "src/new.ts" },
    }
    const result = translateSessionUpdate(update, ctx())
    expect(result[1]).toMatchObject({
      type: "tool-input",
      input: {
        intent: "move",
        sourcePath: "src/old.ts",
        targetPath: "src/new.ts",
        filePath: "src/old.ts",
      },
    })
  })

  it("delete with locations → delete intent hydrates filePath from location", () => {
    const update: SessionUpdate = {
      sessionUpdate: "tool_call",
      toolCallId: "tc1",
      title: "Delete",
      kind: "delete",
      locations: [{ path: "src/old.ts" }],
    }
    const result = translateSessionUpdate(update, ctx())
    expect(result[1]).toMatchObject({
      type: "tool-input",
      input: { intent: "delete", filePath: "src/old.ts" },
    })
  })

  it("read title without path-like detail stays read without fake filePath", () => {
    const update: SessionUpdate = {
      sessionUpdate: "tool_call",
      toolCallId: "tc1",
      title: "Read File",
      kind: "read",
      rawInput: {},
    }
    const result = translateSessionUpdate(update, ctx())
    expect(result[0]).toMatchObject({ type: "tool-start", toolName: "read" })
    expect(result[1]).toMatchObject({
      type: "tool-input",
      input: { intent: "read", summary: "Read File" },
    })
    expect((result[1] as { input: Record<string, unknown> }).input.filePath).toBeUndefined()
  })

  it("Read Lints routes to lint intent instead of generic read", () => {
    const update: SessionUpdate = {
      sessionUpdate: "tool_call",
      toolCallId: "tc1",
      title: "Read Lints",
      kind: "read",
      rawInput: {},
    }
    const result = translateSessionUpdate(update, ctx("cursor-acp"))
    expect(result[0]).toMatchObject({ type: "tool-start", toolName: "lint" })
    expect(result[1]).toMatchObject({
      type: "tool-input",
      input: { intent: "lint", summary: "Read Lints" },
      metadata: { acp: { client: "cursor-acp", extractor: "cursor-lints", intent: "lint" } },
    })
  })

  it("edit title without path-like detail stays edit without fake filePath", () => {
    const update: SessionUpdate = {
      sessionUpdate: "tool_call",
      toolCallId: "tc1",
      title: "Edit File",
      kind: "edit",
      rawInput: {},
    }
    const result = translateSessionUpdate(update, ctx())
    expect(result[0]).toMatchObject({ type: "tool-start", toolName: "edit" })
    expect(result[1]).toMatchObject({
      type: "tool-input",
      input: { intent: "edit", summary: "Edit File" },
    })
    expect((result[1] as { input: Record<string, unknown> }).input.filePath).toBeUndefined()
  })

  it("toolName updateTodos → session-surface todo-update (no tool row)", () => {
    const update: SessionUpdate = {
      sessionUpdate: "tool_call",
      toolCallId: "tc1",
      title: "Update TODOs",
      rawInput: {
        _toolName: "updateTodos",
        todos: [{ content: "Fix bug", status: "in_progress", priority: "high" }],
      },
    }
    const result = translateSessionUpdate(update, ctx())
    // Session-surface routing: emits todo-update, NOT tool-start
    expect(result).toEqual([{
      type: "todo-update",
      todos: [{ id: "0", description: "Fix bug", status: "in_progress", priority: "high" }],
    }])
  })

  it("toolName task → task with description", () => {
    const update: SessionUpdate = {
      sessionUpdate: "tool_call",
      toolCallId: "tc1",
      title: "Task: Subagent task",
      rawInput: { _toolName: "task" },
    }
    const result = translateSessionUpdate(update, ctx())
    expect(result[0]).toMatchObject({ type: "tool-start", toolName: "task" })
    expect(result[1]).toMatchObject({
      type: "tool-input",
      input: { intent: "task", description: "Subagent task", summary: "Task: Subagent task" },
    })
  })

  it("claude ToolSearch routes to generic intent under claude client", () => {
    const update: SessionUpdate = {
      sessionUpdate: "tool_call",
      toolCallId: "tc1",
      title: "ToolSearch",
      kind: "other",
      rawInput: { query: "agent" },
    }
    const result = translateSessionUpdate(update, ctx("claude-acp"))
    expect(result[1]).toMatchObject({
      type: "tool-input",
      input: { intent: "generic", query: "agent", summary: "ToolSearch" },
      metadata: { acp: { client: "claude-acp", extractor: "claude-generic", intent: "generic" } },
    })
  })

  it("cursor List MCP Resources routes to intent=mcp", () => {
    const update: SessionUpdate = {
      sessionUpdate: "tool_call",
      toolCallId: "tc1",
      title: "List MCP Resources",
      kind: "read",
      rawInput: {},
    }
    const result = translateSessionUpdate(update, ctx("cursor-acp"))
    expect(result[0]).toMatchObject({ type: "tool-start", toolName: "mcp" })
    expect(result[1]).toMatchObject({
      type: "tool-input",
      input: { intent: "mcp", summary: "List MCP Resources" },
      metadata: { acp: { client: "cursor-acp", extractor: "cursor-mcp-list", intent: "mcp", mode: "list" } },
    })
  })

  it("cursor Fetch MCP Resource routes to intent=mcp", () => {
    const update: SessionUpdate = {
      sessionUpdate: "tool_call",
      toolCallId: "tc1",
      title: "Fetch MCP Resource",
      kind: "fetch",
      rawInput: { server: "myserver", uri: "resource://foo" },
    }
    const result = translateSessionUpdate(update, ctx("cursor-acp"))
    expect(result[0]).toMatchObject({ type: "tool-start", toolName: "mcp" })
    const acp = (result[0] as { metadata?: Record<string, unknown> }).metadata?.acp as Record<string, unknown>
    expect(acp?.intent).toBe("mcp")
    expect(acp?.mode).toBe("fetch")
  })

  it("codex list_mcp_resources routes to intent=mcp", () => {
    const update: SessionUpdate = {
      sessionUpdate: "tool_call",
      toolCallId: "tc1",
      title: "List MCP Resources",
      rawInput: { _toolName: "list_mcp_resources", server: "context7", name: "list_mcp_resources" },
    }
    const result = translateSessionUpdate(update, ctx("codex-acp"))
    expect(result[0]).toMatchObject({ type: "tool-start", toolName: "mcp" })
    expect(result[1]).toMatchObject({
      type: "tool-input",
      input: { intent: "mcp", summary: "List MCP Resources" },
      metadata: { acp: { client: "codex-acp", intent: "mcp" } },
    })
  })

  it("codex codesearch routes to search/codebase", () => {
    const update: SessionUpdate = {
      sessionUpdate: "tool_call",
      toolCallId: "tc1",
      title: "Code Search",
      kind: "search",
      rawInput: { _toolName: "codesearch", query: "agent session" },
    }
    const result = translateSessionUpdate(update, ctx("codex-acp"))
    expect(result[0]).toMatchObject({ type: "tool-start", toolName: "codesearch" })
    expect(result[1]).toMatchObject({
      type: "tool-input",
      input: { intent: "search", mode: "codebase", query: "agent session" },
      metadata: { acp: { client: "codex-acp", intent: "search", mode: "codebase" } },
    })
  })

  it("codex find routes to list/files", () => {
    const update: SessionUpdate = {
      sessionUpdate: "tool_call",
      toolCallId: "tc1",
      title: "Find",
      kind: "search",
      rawInput: { _toolName: "find", queries: ["src/**/*.ts"] },
    }
    const result = translateSessionUpdate(update, ctx("codex-acp"))
    expect(result[0]).toMatchObject({ type: "tool-start", toolName: "find" })
    expect(result[1]).toMatchObject({
      type: "tool-input",
      input: { intent: "list", mode: "files", query: "src/**/*.ts", summary: "Find" },
      metadata: { acp: { client: "codex-acp", intent: "list", mode: "files" } },
    })
  })

  it("rawInput undefined → generic normalized tool-input", () => {
    const update: SessionUpdate = {
      sessionUpdate: "tool_call",
      toolCallId: "tc1",
      title: "Tool",
      // rawInput omitted
    }
    const result = translateSessionUpdate(update, ctx())
    expect(result).toHaveLength(2)
    expect(result[0].type).toBe("tool-start")
    expect(result[1]).toMatchObject({ type: "tool-input", input: { intent: "generic", summary: "Tool" } })
  })

  it("content with diff item → normalized tool-input plus file-diff", () => {
    const update: SessionUpdate = {
      sessionUpdate: "tool_call",
      toolCallId: "tc1",
      title: "Edit file",
      content: [{ type: "diff", path: "src/foo.ts", newText: "new", oldText: "old" }],
    }
    const result = translateSessionUpdate(update, ctx())
    expect(result).toHaveLength(3)
    expect(result[1]).toMatchObject({ type: "tool-input", input: { intent: "generic", summary: "Edit file" } })
    expect(result[2]).toEqual({ type: "file-diff", toolCallId: "tc1", path: "src/foo.ts", newText: "new", oldText: "old" })
  })

  it("content with terminal item → normalized tool-input plus tool-terminal", () => {
    const update: SessionUpdate = {
      sessionUpdate: "tool_call",
      toolCallId: "tc1",
      title: "Run cmd",
      content: [{ type: "terminal", terminalId: "term-1" }],
    }
    const result = translateSessionUpdate(update, ctx())
    expect(result).toHaveLength(3)
    expect(result[1]).toMatchObject({ type: "tool-input", input: { intent: "generic", summary: "Run cmd" } })
    expect(result[2]).toEqual({ type: "tool-terminal", toolCallId: "tc1", terminalId: "term-1" })
  })

  it("locations present → normalized tool-input plus tool-location", () => {
    const update: SessionUpdate = {
      sessionUpdate: "tool_call",
      toolCallId: "tc1",
      title: "Read",
      locations: [{ path: "src/foo.ts", line: 10 }],
    }
    const result = translateSessionUpdate(update, ctx())
    expect(result).toHaveLength(3)
    expect(result[1]).toMatchObject({ type: "tool-input", input: { intent: "generic", summary: "Read" } })
    expect(result[2]).toEqual({ type: "tool-location", toolCallId: "tc1", locations: [{ path: "src/foo.ts", line: 10 }] })
  })
})

// ---------------------------------------------------------------------------
// tool_call_update
// ---------------------------------------------------------------------------

describe("tool_call_update", () => {
  describe("status=completed", () => {
    it("no content → [tool-output]", () => {
      const update: SessionUpdate = {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc1",
        status: "completed",
        rawOutput: "done",
      }
      const result = translateSessionUpdate(update, ctx())
      expect(result).toMatchObject([{ type: "tool-output", toolCallId: "tc1", output: "done" }])
    })

    it("rawInput present → [tool-input, tool-output] (input captured for display)", () => {
      const update: SessionUpdate = {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc1",
        status: "completed",
        rawOutput: "file contents",
        rawInput: { filePath: "/src/foo.ts" },
      }
      const result = translateSessionUpdate(update, ctx())
      expect(result).toHaveLength(2)
      expect(result[0]).toMatchObject({ type: "tool-input", toolCallId: "tc1", input: { filePath: "/src/foo.ts" } })
      expect(result[1]).toMatchObject({ type: "tool-output" })
    })

    it("rawInput={} with title path → [tool-input(synthetic), tool-output]", () => {
      const update: SessionUpdate = {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc1",
        status: "completed",
        rawOutput: "file contents",
        rawInput: {},
        title: "Read /src/foo.ts",
        kind: "read",
      }
      const result = translateSessionUpdate(update, ctx())
      expect(result).toHaveLength(2)
      expect(result[0]).toMatchObject({ type: "tool-input", toolCallId: "tc1", input: { filePath: "/src/foo.ts" } })
      expect(result[1]).toMatchObject({ type: "tool-output" })
    })

    it("execute rawInput on completion → normalized bash command input before output", () => {
      const update: SessionUpdate = {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc1",
        status: "completed",
        rawOutput: "ok",
        title: "Run git branch -a",
        kind: "execute",
        rawInput: {
          command: ["/bin/zsh", "-lc", "git branch -a"],
          parsed_cmd: [{ type: "unknown", cmd: "git branch -a" }],
        },
      }
      const result = translateSessionUpdate(update, ctx())
      expect(result[0]).toMatchObject({
        type: "tool-input",
        toolCallId: "tc1",
        input: {
          command: "git branch -a",
          parsed_cmd: [{ type: "unknown", cmd: "git branch -a" }],
          description: "git branch -a",
        },
      })
      expect(result[1]).toMatchObject({ type: "tool-output", toolCallId: "tc1", output: "ok" })
    })

    it("content with diff → [tool-output, file-diff per diff]", () => {
      const update: SessionUpdate = {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc1",
        status: "completed",
        rawOutput: null,
        content: [
          { type: "diff", path: "a.ts", newText: "new-a", oldText: "old-a" },
          { type: "diff", path: "b.ts", newText: "new-b" },
        ],
      }
      const result = translateSessionUpdate(update, ctx())
      expect(result).toHaveLength(4)
      expect(result[0]).toMatchObject({
        type: "tool-input",
        toolCallId: "tc1",
        input: { filePath: "a.ts", files: ["a.ts", "b.ts"] },
      })
      expect(result[1]).toMatchObject({ type: "tool-output" })
      expect(result[2]).toEqual({ type: "file-diff", toolCallId: "tc1", path: "a.ts", newText: "new-a", oldText: "old-a" })
      expect(result[3]).toEqual({ type: "file-diff", toolCallId: "tc1", path: "b.ts", newText: "new-b", oldText: undefined })
    })

    it("content with terminal → [tool-output, tool-terminal]", () => {
      const update: SessionUpdate = {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc1",
        status: "completed",
        content: [{ type: "terminal", terminalId: "term-2" }],
      }
      const result = translateSessionUpdate(update, ctx())
      expect(result).toHaveLength(2)
      expect(result[1]).toEqual({ type: "tool-terminal", toolCallId: "tc1", terminalId: "term-2" })
    })

    it("content with type=content → [tool-output] (content items dropped)", () => {
      const update: SessionUpdate = {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc1",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "summary" } }],
      }
      const result = translateSessionUpdate(update, ctx())
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe("tool-output")
    })

    it("rawOutput null, has content → output is content array", () => {
      const contentItems = [{ type: "content" as const, content: { type: "text" as const, text: "out" } }]
      const update: SessionUpdate = {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc1",
        status: "completed",
        rawOutput: null,
        content: contentItems,
      }
      // When rawOutput is null (not undefined), rawOutput ?? content gives content
      // rawOutput is null, so rawOutput !== undefined → use rawOutput (null)?
      // Actually: null !== undefined → we use rawOutput = null?
      // Let's check: rawOutput !== undefined is false only when rawOutput IS undefined
      // null !== undefined → true → output = null
      // Wait, the code is: rawOutput !== undefined ? rawOutput : content
      // null !== undefined → true → output = null
      // But wait - actually for the case "rawOutput null, has content → output is content array"
      // We need: when rawOutput IS null (explicitly), use content
      // Actually let me re-read: "rawOutput null, has content → output is content array"
      // This means when rawOutput is null (not set meaningfully), fall back to content
      // BUT our code uses: `rawOutput !== undefined ? rawOutput : content`
      // null !== undefined → true → output = null (not content array!)
      // This is a tension in the spec. Let me check: the plan says:
      // "rawOutput null, has content → output is content array"
      // I think the intended check is: `rawOutput != null ? rawOutput : content`
      // Let me use null check (== null covers both null and undefined)
      const result = translateSessionUpdate(update, ctx())
      expect(result[0]).toMatchObject({ type: "tool-output", toolCallId: "tc1" })
      // The output when rawOutput=null and content present should be content array
      expect((result[0] as { output: unknown }).output).toEqual(contentItems)
    })
  })

  describe("status=failed", () => {
    it("with rawOutput → [tool-error]", () => {
      const update: SessionUpdate = {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc1",
        status: "failed",
        rawOutput: "error message",
      }
      const result = translateSessionUpdate(update, ctx())
      expect(result).toMatchObject([{ type: "tool-error", toolCallId: "tc1", error: "error message" }])
    })

    it("no rawOutput → tool-error with empty string", () => {
      const update: SessionUpdate = {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc1",
        status: "failed",
      }
      const result = translateSessionUpdate(update, ctx())
      expect(result).toMatchObject([{ type: "tool-error", toolCallId: "tc1", error: "" }])
    })

    it("structured error objects are formatted into readable text", () => {
      const update: SessionUpdate = {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc1",
        status: "failed",
        rawOutput: { stdout: "", stderr: "ENOENT: no such file or directory", exitCode: 1 },
      }
      const result = translateSessionUpdate(update, ctx())
      expect(result).toMatchObject([{ type: "tool-error", toolCallId: "tc1", error: "ENOENT: no such file or directory" }])
    })

    it("diff content is preserved alongside the failed tool row", () => {
      const update: SessionUpdate = {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc1",
        status: "failed",
        rawOutput: "fail",
        content: [{ type: "diff", path: "x.ts", newText: "new" }],
      }
      const result = translateSessionUpdate(update, ctx())
      expect(result).toHaveLength(3)
      expect(result[0]).toMatchObject({
        type: "tool-input",
        toolCallId: "tc1",
        input: { intent: "generic", summary: "Tool", files: ["x.ts"] },
      })
      expect(result[1]).toMatchObject({ type: "tool-error", toolCallId: "tc1", error: "fail" })
      expect(result[2]).toEqual({ type: "file-diff", toolCallId: "tc1", path: "x.ts", newText: "new", oldText: undefined })
    })
  })

  describe("status=in_progress", () => {
    it("rawInput present → [tool-input]", () => {
      const update: SessionUpdate = {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc1",
        status: "in_progress",
        rawInput: { file: "foo.ts" },
      }
      const result = translateSessionUpdate(update, ctx())
      expect(result).toMatchObject([{
        type: "tool-input",
        toolCallId: "tc1",
        input: { file: "foo.ts", intent: "generic", summary: "Tool" },
        metadata: { acp: { rawInput: { file: "foo.ts" }, status: "running" } },
      }])
    })

    it("rawInput absent → []", () => {
      const update: SessionUpdate = {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc1",
        status: "in_progress",
      }
      expect(translateSessionUpdate(update, ctx())).toEqual([])
    })

    it("locations present → [tool-location]", () => {
      const update: SessionUpdate = {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc1",
        status: "in_progress",
        locations: [{ path: "src/bar.ts" }],
      }
      const result = translateSessionUpdate(update, ctx())
      expect(result).toEqual([{ type: "tool-location", toolCallId: "tc1", locations: [{ path: "src/bar.ts", line: undefined }] }])
    })

    it("cursor sparse completed edit inherits prior diff path", () => {
      const c = ctx("cursor-acp")
      translateSessionUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "tc1",
        title: "Edit File",
        kind: "edit",
        rawInput: {},
      }, c)
      const result = translateSessionUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "tc1",
        status: "completed",
        content: [{ type: "diff", path: "/tmp/demo.txt", oldText: "x", newText: "y" }],
      }, c)
      expect(result[0]).toMatchObject({
        type: "tool-input",
        input: { intent: "edit", filePath: "/tmp/demo.txt" },
        metadata: { acp: { client: "cursor-acp", extractor: "cursor-edit", hasDiff: true } },
      })
      expect(result[1]).toMatchObject({ type: "tool-output", toolCallId: "tc1" })
      expect(result[2]).toEqual({ type: "file-diff", toolCallId: "tc1", path: "/tmp/demo.txt", oldText: "x", newText: "y" })
    })
  })

  describe("status=pending", () => {
    it("→ []", () => {
      const update: SessionUpdate = {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc1",
        status: "pending",
      }
      expect(translateSessionUpdate(update, ctx())).toEqual([])
    })
  })

  describe("status=null/undefined", () => {
    it("→ []", () => {
      const updateNull: SessionUpdate = {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc1",
        status: null,
      }
      expect(translateSessionUpdate(updateNull, ctx())).toEqual([])

      const updateUndef: SessionUpdate = {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc1",
      }
      expect(translateSessionUpdate(updateUndef, ctx())).toEqual([])
    })
  })
})

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------

describe("plan", () => {
  it("entries → todo-update using e.content not e.title", () => {
    const update: SessionUpdate = {
      sessionUpdate: "plan",
      entries: [
        { content: "Implement feature X", status: "pending", priority: "high" },
        { content: "Write tests", status: "in_progress", priority: "medium" },
      ],
    }
    const result = translateSessionUpdate(update, ctx())
    expect(result).toHaveLength(1)
    const todoUpdate = result[0] as { type: "todo-update"; todos: unknown[] }
    expect(todoUpdate.type).toBe("todo-update")
    expect(todoUpdate.todos[0]).toMatchObject({ description: "Implement feature X" })
    expect(todoUpdate.todos[1]).toMatchObject({ description: "Write tests" })
  })

  it("id is String(i) not e.id (e.id doesn't exist)", () => {
    const update: SessionUpdate = {
      sessionUpdate: "plan",
      entries: [
        { content: "Task A", status: "pending", priority: "low" },
        { content: "Task B", status: "pending", priority: "low" },
      ],
    }
    const result = translateSessionUpdate(update, ctx())
    const todos = (result[0] as { todos: Array<{ id: string }> }).todos
    expect(todos[0].id).toBe("0")
    expect(todos[1].id).toBe("1")
  })

  it("priority is carried through", () => {
    const update: SessionUpdate = {
      sessionUpdate: "plan",
      entries: [{ content: "Do thing", status: "pending", priority: "high" }],
    }
    const result = translateSessionUpdate(update, ctx())
    const todos = (result[0] as { todos: Array<{ priority: string }> }).todos
    expect(todos[0].priority).toBe("high")
  })

  it("empty entries → todo-update with empty array", () => {
    const update: SessionUpdate = {
      sessionUpdate: "plan",
      entries: [],
    }
    const result = translateSessionUpdate(update, ctx())
    expect(result).toEqual([{ type: "todo-update", todos: [] }])
  })
})

// ---------------------------------------------------------------------------
// available_commands_update
// ---------------------------------------------------------------------------

describe("available_commands_update", () => {
  it("→ []", () => {
    const update: SessionUpdate = {
      sessionUpdate: "available_commands_update",
      availableCommands: [{ name: "/help", description: "Help" }],
    }
    expect(translateSessionUpdate(update, ctx())).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// current_mode_update
// ---------------------------------------------------------------------------

describe("current_mode_update", () => {
  it("modeId → session-agent with agentId", () => {
    const update: SessionUpdate = {
      sessionUpdate: "current_mode_update",
      currentModeId: "plan",
    }
    expect(translateSessionUpdate(update, ctx())).toEqual([{ type: "session-agent", agentId: "plan" }])
  })
})

// ---------------------------------------------------------------------------
// config_option_update
// ---------------------------------------------------------------------------

describe("config_option_update", () => {
  it("select options → config-update", () => {
    const update: SessionUpdate = {
      sessionUpdate: "config_option_update",
      configOptions: [{
        type: "select",
        id: "thought_level",
        name: "Thinking",
        category: "thought_level",
        currentValue: "high",
        options: [
          { value: "none", name: "Off" },
          { value: "low", name: "Low" },
          { value: "high", name: "High" },
        ],
      }],
    }
    const result = translateSessionUpdate(update, ctx())
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      type: "config-update",
      options: [{
        id: "thought_level",
        type: "select",
        currentValue: "high",
        selectOptions: [
          { id: "none", name: "Off" },
          { id: "low", name: "Low" },
          { id: "high", name: "High" },
        ],
      }],
    })
  })

  it("boolean options → config-update", () => {
    const update: SessionUpdate = {
      sessionUpdate: "config_option_update",
      configOptions: [{
        type: "boolean",
        id: "stream_mode",
        name: "Stream Mode",
        currentValue: true,
      }],
    }
    const result = translateSessionUpdate(update, ctx())
    expect(result[0]).toMatchObject({
      type: "config-update",
      options: [{ id: "stream_mode", type: "boolean", currentValue: true }],
    })
  })
})

// ---------------------------------------------------------------------------
// session_info_update
// ---------------------------------------------------------------------------

describe("session_info_update", () => {
  it("title present → session-title", () => {
    const update: SessionUpdate = {
      sessionUpdate: "session_info_update",
      title: "My new title",
    }
    expect(translateSessionUpdate(update, ctx())).toEqual([{ type: "session-title", title: "My new title" }])
  })

  it("title null → []", () => {
    const update: SessionUpdate = {
      sessionUpdate: "session_info_update",
      title: null,
    }
    expect(translateSessionUpdate(update, ctx())).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// usage_update
// ---------------------------------------------------------------------------

describe("usage_update", () => {
  it("size + used → usage chunk", () => {
    const update: SessionUpdate = {
      sessionUpdate: "usage_update",
      size: 200000,
      used: 45230,
    }
    expect(translateSessionUpdate(update, ctx())).toEqual([{
      type: "usage",
      contextSize: 200000,
      contextUsed: 45230,
    }])
  })

  it("with cost → usage chunk includes cost", () => {
    const update: SessionUpdate = {
      sessionUpdate: "usage_update",
      size: 100000,
      used: 30000,
      cost: { amount: 0.032, currency: "USD" },
    }
    expect(translateSessionUpdate(update, ctx())).toEqual([{
      type: "usage",
      contextSize: 100000,
      contextUsed: 30000,
      cost: { amount: 0.032, currency: "USD" },
    }])
  })
})

// ---------------------------------------------------------------------------
// translateStopReason
// ---------------------------------------------------------------------------

describe("translateStopReason", () => {
  it("end_turn → [session-status idle, finish]", () => {
    const result = translateStopReason("end_turn", "sess-1")
    expect(result).toEqual([
      { type: "session-status", status: "idle" },
      { type: "finish", sessionId: "sess-1" },
    ])
  })

  it("max_tokens → [session-status idle, finish]", () => {
    const result = translateStopReason("max_tokens", "sess-1")
    expect(result).toEqual([
      { type: "session-status", status: "idle" },
      { type: "finish", sessionId: "sess-1" },
    ])
  })

  it("max_turn_requests → [session-status idle, finish]", () => {
    const result = translateStopReason("max_turn_requests", "sess-1")
    expect(result).toEqual([
      { type: "session-status", status: "idle" },
      { type: "finish", sessionId: "sess-1" },
    ])
  })

  it("cancelled → [session-status idle] only — no finish", () => {
    const result = translateStopReason("cancelled", "sess-1")
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ type: "session-status", status: "idle" })
    expect(result.find((c) => c.type === "finish")).toBeUndefined()
  })

  it("refusal → [session-status error, error chunk]", () => {
    const result = translateStopReason("refusal", "sess-1")
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ type: "session-status", status: "error" })
    expect(result[1]).toMatchObject({ type: "error" })
  })
})

// ---------------------------------------------------------------------------
// Per-client tool normalization tests (Phase 2-3)
// ---------------------------------------------------------------------------

describe("per-client normalization", () => {
  function meta(result: ReturnType<typeof translateSessionUpdate>, idx: number) {
    const event = result[idx] as { metadata?: Record<string, unknown> }
    return event.metadata?.acp as Record<string, unknown> | undefined
  }

  // -------------------------------------------------------------------------
  // Cursor: shell, read, edit, delete, list/glob, grep, web, codebase
  // -------------------------------------------------------------------------

  describe("cursor-acp normalization", () => {
    it("shell: command survives from parsed_cmd", () => {
      const update: SessionUpdate = {
        sessionUpdate: "tool_call",
        toolCallId: "tc1",
        title: "Terminal git push",
        kind: "execute",
        rawInput: { parsed_cmd: [{ type: "shell", cmd: "git push" }] },
        content: [{ type: "terminal", terminalId: "t1" }],
      }
      const result = translateSessionUpdate(update, ctx("cursor-acp"))
      expect(result[0]).toMatchObject({ type: "tool-start", toolName: "bash" })
      expect(meta(result, 0)?.intent).toBe("shell")
      expect(result[1]).toMatchObject({ input: { command: "git push" } })
    })

    it("shell: no duplicate title in shell output", () => {
      const update: SessionUpdate = {
        sessionUpdate: "tool_call",
        toolCallId: "tc1",
        title: "Terminal",
        kind: "execute",
        rawInput: {},
      }
      const result = translateSessionUpdate(update, ctx("cursor-acp"))
      expect(result[0]).toMatchObject({ type: "tool-start", toolName: "bash" })
    })

    it("shell: output-only cursor shells keep shell intent with result mode", () => {
      const c = ctx("cursor-acp")
      translateSessionUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "tc1",
        title: "Terminal",
        kind: "execute",
        rawInput: {},
      }, c)
      const result = translateSessionUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "tc1",
        status: "completed",
        rawOutput: { stdout: "27\n", stderr: "", exitCode: 0 },
      }, c)
      expect(result[0]).toMatchObject({
        type: "tool-output",
        output: { stdout: "27\n", stderr: "", exitCode: 0 },
      })
      expect(meta(result, 0)?.intent).toBe("shell")
      expect(meta(result, 0)?.mode).toBe("result")
    })

    it("read: file path from locations survives", () => {
      const update: SessionUpdate = {
        sessionUpdate: "tool_call",
        toolCallId: "tc1",
        title: "Read File",
        kind: "read",
        rawInput: null,
        locations: [{ path: "/src/foo.ts", line: 10 }],
      }
      const result = translateSessionUpdate(update, ctx("cursor-acp"))
      expect(result[0]).toMatchObject({ type: "tool-start", toolName: "read" })
      expect(result[1]).toMatchObject({ input: { filePath: "/src/foo.ts" } })
    })

    it("edit: diff content survives", () => {
      const update: SessionUpdate = {
        sessionUpdate: "tool_call",
        toolCallId: "tc1",
        title: "Edit File",
        kind: "edit",
        rawInput: null,
        content: [{ type: "diff", path: "/src/foo.ts", oldText: "old", newText: "new" }],
        locations: [{ path: "/src/foo.ts", line: 5 }],
      }
      const result = translateSessionUpdate(update, ctx("cursor-acp"))
      expect(result[0]).toMatchObject({ type: "tool-start", toolName: "edit" })
      const diffs = result.filter((e) => e.type === "file-diff")
      expect(diffs.length).toBe(1)
    })

    it("delete: file path survives", () => {
      const update: SessionUpdate = {
        sessionUpdate: "tool_call",
        toolCallId: "tc1",
        title: "Delete File /src/old.ts",
        kind: "delete",
        rawInput: null,
        locations: [{ path: "/src/old.ts" }],
      }
      const result = translateSessionUpdate(update, ctx("cursor-acp"))
      expect(meta(result, 0)?.intent).toBe("delete")
      expect(result[1]).toMatchObject({ input: { filePath: "/src/old.ts" } })
    })

    it("find glob: pattern survives with list intent", () => {
      const update: SessionUpdate = {
        sessionUpdate: "tool_call",
        toolCallId: "tc1",
        title: "Find",
        kind: "search",
        rawInput: { parsed_cmd: [{ type: "glob", path: "/src", pattern: "*.ts" }] },
      }
      const result = translateSessionUpdate(update, ctx("cursor-acp"))
      expect(result[0]).toMatchObject({ type: "tool-start", toolName: "glob" })
      expect(meta(result, 0)?.intent).toBe("list")
      expect(result[1]).toMatchObject({ input: { pattern: "*.ts", path: "/src" } })
    })

    it("grep: pattern and path survive", () => {
      const update: SessionUpdate = {
        sessionUpdate: "tool_call",
        toolCallId: "tc1",
        title: "grep",
        kind: "search",
        rawInput: { parsed_cmd: [{ type: "search", query: "TODO", path: "/src" }] },
      }
      const result = translateSessionUpdate(update, ctx("cursor-acp"))
      expect(result[0]).toMatchObject({ type: "tool-start", toolName: "grep" })
      expect(meta(result, 0)?.intent).toBe("search")
    })

    it("web search: query survives with search/web", () => {
      const update: SessionUpdate = {
        sessionUpdate: "tool_call",
        toolCallId: "tc1",
        title: "Web Search",
        kind: "search",
        rawInput: { query: "typescript generics" },
      }
      const result = translateSessionUpdate(update, ctx("cursor-acp"))
      expect(meta(result, 0)?.intent).toBe("search")
      expect(meta(result, 0)?.mode).toBe("web")
      expect(result[1]).toMatchObject({ input: { query: "typescript generics" } })
    })

    it("codebase search: query survives with search/codebase", () => {
      const update: SessionUpdate = {
        sessionUpdate: "tool_call",
        toolCallId: "tc1",
        title: "Codebase Search",
        kind: "search",
        rawInput: { query: "auth middleware" },
      }
      const result = translateSessionUpdate(update, ctx("cursor-acp"))
      expect(meta(result, 0)?.intent).toBe("search")
      expect(meta(result, 0)?.mode).toBe("codebase")
      expect(result[1]).toMatchObject({ input: { query: "auth middleware" } })
    })

    it("sparse input never invents a file path", () => {
      const update: SessionUpdate = {
        sessionUpdate: "tool_call",
        toolCallId: "tc1",
        title: "Read File",
        kind: "read",
        rawInput: {},
      }
      const result = translateSessionUpdate(update, ctx("cursor-acp"))
      expect(result[1]?.input?.filePath).toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // Claude: Bash, Read, Edit, Write, Glob, Grep, WebSearch, WebFetch
  // -------------------------------------------------------------------------

  describe("claude-acp normalization", () => {
    it("Bash: toolName takes precedence over kind", () => {
      const update: SessionUpdate = {
        sessionUpdate: "tool_call",
        toolCallId: "tc1",
        title: "Terminal echo hello",
        kind: "execute",
        rawInput: { _toolName: "Bash", command: "echo hello" },
        content: [{ type: "terminal", terminalId: "t1" }],
      }
      const result = translateSessionUpdate(update, ctx("claude-acp"))
      expect(result[0]).toMatchObject({ type: "tool-start", toolName: "bash" })
      expect(meta(result, 0)?.intent).toBe("shell")
      expect(result[1]).toMatchObject({ input: { command: "echo hello" } })
    })

    it("Read: filePath survives from rawInput", () => {
      const update: SessionUpdate = {
        sessionUpdate: "tool_call",
        toolCallId: "tc1",
        title: "Read /src/index.ts",
        kind: "read",
        rawInput: { _toolName: "Read", filePath: "/src/index.ts" },
        locations: [{ path: "/src/index.ts" }],
      }
      const result = translateSessionUpdate(update, ctx("claude-acp"))
      expect(result[0]).toMatchObject({ type: "tool-start", toolName: "read" })
      expect(result[1]).toMatchObject({ input: { filePath: "/src/index.ts" } })
    })

    it("Edit: file path and diff survive", () => {
      const update: SessionUpdate = {
        sessionUpdate: "tool_call",
        toolCallId: "tc1",
        title: "Edit /src/app.ts",
        kind: "edit",
        rawInput: { _toolName: "Edit", filePath: "/src/app.ts" },
        content: [{ type: "diff", path: "/src/app.ts", oldText: "a", newText: "b" }],
        locations: [{ path: "/src/app.ts" }],
      }
      const result = translateSessionUpdate(update, ctx("claude-acp"))
      expect(result[0]).toMatchObject({ type: "tool-start", toolName: "edit" })
      expect(result.filter((e) => e.type === "file-diff").length).toBe(1)
    })

    it("Write: maps to edit intent", () => {
      const update: SessionUpdate = {
        sessionUpdate: "tool_call",
        toolCallId: "tc1",
        title: "Write /src/new.ts",
        kind: "edit",
        rawInput: { _toolName: "Write", filePath: "/src/new.ts" },
        content: [{ type: "diff", path: "/src/new.ts", oldText: "", newText: "new content" }],
      }
      const result = translateSessionUpdate(update, ctx("claude-acp"))
      expect(meta(result, 0)?.intent).toBe("edit")
    })

    it("Glob: normalizes to list/glob", () => {
      const update: SessionUpdate = {
        sessionUpdate: "tool_call",
        toolCallId: "tc1",
        title: "Find",
        kind: "search",
        rawInput: { _toolName: "Glob", pattern: "**/*.ts", path: "/src" },
      }
      const result = translateSessionUpdate(update, ctx("claude-acp"))
      expect(meta(result, 0)?.intent).toBe("list")
    })

    it("Grep: normalizes to search with pattern and path", () => {
      const update: SessionUpdate = {
        sessionUpdate: "tool_call",
        toolCallId: "tc1",
        title: "grep",
        kind: "search",
        rawInput: { _toolName: "Grep", pattern: "TODO", path: "/src" },
      }
      const result = translateSessionUpdate(update, ctx("claude-acp"))
      expect(meta(result, 0)?.intent).toBe("search")
      expect(result[1]).toMatchObject({ input: { pattern: "TODO", path: "/src" } })
    })

    it("WebSearch: normalizes to search/web", () => {
      const update: SessionUpdate = {
        sessionUpdate: "tool_call",
        toolCallId: "tc1",
        title: "Web Search",
        kind: "fetch",
        rawInput: { _toolName: "WebSearch", query: "react hooks" },
      }
      const result = translateSessionUpdate(update, ctx("claude-acp"))
      // WebSearch _toolName matches the registry rule → intent=search, mode=web
      expect(meta(result, 0)?.intent).toBe("search")
      expect(meta(result, 0)?.mode).toBe("web")
      expect(result[1]).toMatchObject({ input: { query: "react hooks" } })
    })

    it("WebFetch: normalizes to fetch/web with URL", () => {
      const update: SessionUpdate = {
        sessionUpdate: "tool_call",
        toolCallId: "tc1",
        title: "Fetch https://example.com",
        kind: "fetch",
        rawInput: { _toolName: "WebFetch", url: "https://example.com" },
      }
      const result = translateSessionUpdate(update, ctx("claude-acp"))
      expect(meta(result, 0)?.intent).toBe("fetch")
      expect(result[1]).toMatchObject({ input: { url: "https://example.com" } })
    })

    it("sparse: no file path invented when only title exists", () => {
      const update: SessionUpdate = {
        sessionUpdate: "tool_call",
        toolCallId: "tc1",
        title: "Read File",
        kind: "read",
        rawInput: { _toolName: "Read" },
      }
      const result = translateSessionUpdate(update, ctx("claude-acp"))
      // Title "Read File" doesn't have a path → filePath should not exist
      expect(result[1]?.input?.filePath).toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // Codex: shell, read, edit, search, list, delete
  // -------------------------------------------------------------------------

  describe("codex-acp normalization", () => {
    it("shell: parsed command extracts command", () => {
      const update: SessionUpdate = {
        sessionUpdate: "tool_call",
        toolCallId: "tc1",
        title: "Run npm test",
        kind: "execute",
        rawInput: { command: ["bash", "-lc", "npm test"], parsed_cmd: [{ type: "shell", cmd: "npm test" }] },
      }
      const result = translateSessionUpdate(update, ctx("codex-acp"))
      expect(result[0]).toMatchObject({ type: "tool-start", toolName: "bash" })
      expect(result[1]).toMatchObject({ input: { command: "npm test" } })
    })

    it("read: filePath survives from rawInput", () => {
      const update: SessionUpdate = {
        sessionUpdate: "tool_call",
        toolCallId: "tc1",
        title: "Read /src/main.ts",
        kind: "read",
        rawInput: { filePath: "/src/main.ts" },
        locations: [{ path: "/src/main.ts" }],
      }
      const result = translateSessionUpdate(update, ctx("codex-acp"))
      expect(result[0]).toMatchObject({ type: "tool-start", toolName: "read" })
      expect(result[1]).toMatchObject({ input: { filePath: "/src/main.ts" } })
    })

    it("edit: diff survives", () => {
      const update: SessionUpdate = {
        sessionUpdate: "tool_call",
        toolCallId: "tc1",
        title: "Edit /src/app.ts",
        kind: "edit",
        rawInput: { filePath: "/src/app.ts" },
        content: [{ type: "diff", path: "/src/app.ts", oldText: "x", newText: "y" }],
      }
      const result = translateSessionUpdate(update, ctx("codex-acp"))
      expect(result.filter((e) => e.type === "file-diff").length).toBe(1)
    })

    it("search: grep pattern from parsed_cmd", () => {
      const update: SessionUpdate = {
        sessionUpdate: "tool_call",
        toolCallId: "tc1",
        title: "Search TODO",
        kind: "search",
        rawInput: { parsed_cmd: [{ type: "search", query: "TODO", path: "/src" }] },
      }
      const result = translateSessionUpdate(update, ctx("codex-acp"))
      expect(meta(result, 0)?.intent).toBe("search")
    })

    it("list: list_files parsed command normalizes to list intent", () => {
      const update: SessionUpdate = {
        sessionUpdate: "tool_call",
        toolCallId: "tc1",
        title: "List files",
        kind: "search",
        rawInput: { parsed_cmd: [{ type: "list_files", path: "/src" }] },
      }
      const result = translateSessionUpdate(update, ctx("codex-acp"))
      expect(meta(result, 0)?.intent).toBe("list")
    })

    it("delete: preserves file path and intent", () => {
      const update: SessionUpdate = {
        sessionUpdate: "tool_call",
        toolCallId: "tc1",
        title: "Delete /tmp/old.ts",
        kind: "delete",
        rawInput: { filePath: "/tmp/old.ts" },
        locations: [{ path: "/tmp/old.ts" }],
      }
      const result = translateSessionUpdate(update, ctx("codex-acp"))
      expect(meta(result, 0)?.intent).toBe("delete")
      expect(result[1]).toMatchObject({ input: { filePath: "/tmp/old.ts" } })
    })

    it("sparse: no command invented when rawInput is empty", () => {
      const update: SessionUpdate = {
        sessionUpdate: "tool_call",
        toolCallId: "tc1",
        title: "Terminal",
        kind: "execute",
        rawInput: {},
      }
      const result = translateSessionUpdate(update, ctx("codex-acp"))
      expect(result[0]).toMatchObject({ type: "tool-start", toolName: "bash" })
      // No command in rawInput → shouldn't fabricate one
      expect(result[1]?.input?.command).toBeUndefined()
    })
  })
})

// ---------------------------------------------------------------------------
// Session-surface routing (Phase 4)
// ---------------------------------------------------------------------------

describe("session-surface routing", () => {
  // -------------------------------------------------------------------------
  // todos family: emit todo-update, suppress tool rows
  // -------------------------------------------------------------------------

  describe("todos family", () => {
    it("Cursor UpdateTodos tool_call emits todo-update, not tool-start", () => {
      const update: SessionUpdate = {
        sessionUpdate: "tool_call",
        toolCallId: "tc-todo-1",
        title: "Update TODOs",
        rawInput: {
          _toolName: "updateTodos",
          todos: [
            { content: "Fix bug", status: "in_progress", priority: "high" },
            { content: "Add tests", status: "pending", priority: "medium" },
          ],
        },
      }
      const result = translateSessionUpdate(update, ctx("cursor-acp"))
      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({
        type: "todo-update",
        todos: [
          { id: "0", description: "Fix bug", status: "in_progress", priority: "high" },
          { id: "1", description: "Add tests", status: "pending", priority: "medium" },
        ],
      })
      // No tool-start or tool-input events
      expect(result.filter((e) => e.type === "tool-start")).toHaveLength(0)
      expect(result.filter((e) => e.type === "tool-input")).toHaveLength(0)
    })

    it("Claude TodoWrite tool_call emits todo-update", () => {
      const update: SessionUpdate = {
        sessionUpdate: "tool_call",
        toolCallId: "tc-todo-2",
        title: "Update TODOs",
        rawInput: {
          _toolName: "TodoWrite",
          todos: [{ content: "Implement feature", status: "in_progress" }],
        },
      }
      const result = translateSessionUpdate(update, ctx("claude-acp"))
      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({ type: "todo-update" })
      expect(result.filter((e) => e.type === "tool-start")).toHaveLength(0)
    })

    it("todos tool_call_update completed re-emits todo-update with final state", () => {
      const c = ctx("cursor-acp")
      // Start
      translateSessionUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "tc-todo-3",
        title: "Update TODOs",
        rawInput: {
          _toolName: "updateTodos",
          todos: [{ content: "Draft", status: "pending" }],
        },
      }, c)
      // Complete with updated todos
      const result = translateSessionUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-todo-3",
        status: "completed",
        rawInput: {
          todos: [{ content: "Done", status: "completed", priority: "high" }],
        },
        rawOutput: "OK",
        content: null,
        locations: null,
      }, c)
      expect(result.filter((e) => e.type === "todo-update")).toHaveLength(1)
      // No tool-output event
      expect(result.filter((e) => e.type === "tool-output")).toHaveLength(0)
    })

    it("todos without rawInput.todos still suppresses tool row", () => {
      const update: SessionUpdate = {
        sessionUpdate: "tool_call",
        toolCallId: "tc-todo-4",
        title: "Update TODOs",
        rawInput: { _toolName: "updateTodos" },
      }
      const result = translateSessionUpdate(update, ctx("cursor-acp"))
      // No todo-update (no todos data), but also no tool-start
      expect(result.filter((e) => e.type === "tool-start")).toHaveLength(0)
      expect(result.filter((e) => e.type === "todo-update")).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // question family: emit question or permission-request, suppress tool rows
  // -------------------------------------------------------------------------

  describe("question family", () => {
    it("Cursor askQuestion emits question event, not tool-start", () => {
      const update: SessionUpdate = {
        sessionUpdate: "tool_call",
        toolCallId: "tc-q-1",
        title: "Ask Question",
        rawInput: {
          _toolName: "askQuestion",
          prompt: "Which database do you want to use?",
          options: ["PostgreSQL", "SQLite"],
        },
      }
      const result = translateSessionUpdate(update, ctx("cursor-acp"))
      expect(result.filter((e) => e.type === "tool-start")).toHaveLength(0)
      expect(result[0]).toMatchObject({
        type: "question",
        requestId: "tc-q-1",
        questions: [{ text: "Which database do you want to use?", options: ["PostgreSQL", "SQLite"] }],
      })
    })

    it("Codex permission request emits permission-request event", () => {
      const update: SessionUpdate = {
        sessionUpdate: "tool_call",
        toolCallId: "tc-perm-1",
        title: "Permission",
        rawInput: {
          _toolName: "permission",
          reason: "Need write access to /src",
          scopes: ["/src"],
        },
      }
      const result = translateSessionUpdate(update, ctx("codex-acp"))
      expect(result.filter((e) => e.type === "tool-start")).toHaveLength(0)
      expect(result[0]).toMatchObject({
        type: "permission-request",
        requestId: "tc-perm-1",
        tool: "Need write access to /src",
        paths: ["/src"],
      })
    })

    it("question tool_call_update does not emit tool-output", () => {
      const c = ctx("cursor-acp")
      translateSessionUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "tc-q-2",
        title: "Ask Question",
        rawInput: { _toolName: "askQuestion", prompt: "Continue?" },
      }, c)
      const result = translateSessionUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-q-2",
        status: "completed",
        rawInput: undefined,
        rawOutput: "yes",
        content: null,
        locations: null,
      }, c)
      expect(result.filter((e) => e.type === "tool-output")).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // reasoning family: suppress tool rows entirely
  // -------------------------------------------------------------------------

  describe("reasoning family", () => {
    it("Claude ExitPlanMode emits no tool row", () => {
      const update: SessionUpdate = {
        sessionUpdate: "tool_call",
        toolCallId: "tc-plan-1",
        title: "ExitPlanMode",
        rawInput: { _toolName: "ExitPlanMode" },
      }
      const result = translateSessionUpdate(update, ctx("claude-acp"))
      expect(result.filter((e) => e.type === "tool-start")).toHaveLength(0)
      expect(result.filter((e) => e.type === "tool-input")).toHaveLength(0)
    })

    it("think kind without question name/title maps to reasoning (not question)", () => {
      const update: SessionUpdate = {
        sessionUpdate: "tool_call",
        toolCallId: "tc-think-1",
        title: "Thinking",
        kind: "think",
        rawInput: {},
      }
      const result = translateSessionUpdate(update, ctx("cursor-acp"))
      // think kind defaults to reasoning in intent() fallback → suppressed
      expect(result.filter((e) => e.type === "tool-start")).toHaveLength(0)
    })

    it("reasoning tool_call_update completed emits no tool-output", () => {
      const c = ctx("claude-acp")
      translateSessionUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "tc-plan-2",
        title: "ExitPlanMode",
        rawInput: { _toolName: "ExitPlanMode" },
      }, c)
      const result = translateSessionUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-plan-2",
        status: "completed",
        rawInput: undefined,
        rawOutput: null,
        content: null,
        locations: null,
      }, c)
      expect(result.filter((e) => e.type === "tool-output")).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // Non-session-surface families still produce tool rows
  // -------------------------------------------------------------------------

  describe("non-surface families unaffected", () => {
    it("shell still emits tool-start and tool-input", () => {
      const update: SessionUpdate = {
        sessionUpdate: "tool_call",
        toolCallId: "tc-shell-1",
        title: "Terminal ls",
        kind: "execute",
        rawInput: { command: "ls" },
      }
      const result = translateSessionUpdate(update, ctx("cursor-acp"))
      expect(result.filter((e) => e.type === "tool-start")).toHaveLength(1)
      expect(result.filter((e) => e.type === "tool-input")).toHaveLength(1)
    })

    it("read still emits tool-start", () => {
      const update: SessionUpdate = {
        sessionUpdate: "tool_call",
        toolCallId: "tc-read-1",
        title: "Read File /src/foo.ts",
        kind: "read",
        rawInput: { filePath: "/src/foo.ts" },
      }
      const result = translateSessionUpdate(update, ctx("cursor-acp"))
      expect(result[0]).toMatchObject({ type: "tool-start" })
    })

    it("task still emits tool-start", () => {
      const update: SessionUpdate = {
        sessionUpdate: "tool_call",
        toolCallId: "tc-task-1",
        title: "Task: Subagent task",
        rawInput: { _toolName: "task", description: "Test" },
      }
      const result = translateSessionUpdate(update, ctx("cursor-acp"))
      expect(result[0]).toMatchObject({ type: "tool-start", toolName: "task" })
    })

    it("generic still emits tool-start", () => {
      const update: SessionUpdate = {
        sessionUpdate: "tool_call",
        toolCallId: "tc-gen-1",
        title: "ToolSearch",
        kind: "other",
        rawInput: { _toolName: "ToolSearch" },
      }
      const result = translateSessionUpdate(update, ctx("claude-acp"))
      expect(result[0]).toMatchObject({ type: "tool-start" })
    })
  })

  describe("hardening metadata preservation", () => {
    it("_meta.tool_name participates in classification", () => {
      const result = translateSessionUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "tc-meta-1",
        title: "Something vague",
        _meta: { tool_name: "websearch" },
        rawInput: { query: "ACP transport" },
      } as SessionUpdate, ctx("claude-acp"))
      expect(result[0]).toMatchObject({ type: "tool-start", toolName: "websearch" })
      expect(eventMeta(result, 0)?.intent).toBe("search")
      expect(eventMeta(result, 0)?.meta).toEqual({ tool_name: "websearch" })
    })

    it("Claude parent tool-use metadata is preserved", () => {
      const result = translateSessionUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "tc-child-1",
        title: "Read File",
        kind: "read",
        _meta: { claudeCode: { parentToolUseId: "tc-parent", toolName: "Read" } },
        rawInput: { filePath: "/src/a.ts" },
      } as SessionUpdate, ctx("claude-acp"))
      expect(eventMeta(result, 0)?.parentToolCallId).toBe("tc-parent")
      expect(eventMeta(result, 0)?.rawToolName).toBe("Read")
    })

    it("Cursor question ids and multi-select are preserved in metadata", () => {
      const c = ctx("cursor-acp")
      const result = translateSessionUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "tc-question-meta",
        title: "Ask Question",
        rawInput: {
          _toolName: "askQuestion",
          questions: [
            { id: "q1", prompt: "Pick databases", allowMultiple: true, options: [{ id: "pg", label: "Postgres" }, { id: "sqlite", label: "SQLite" }] },
          ],
        },
      }, c)
      expect(result).toEqual([{
        type: "question",
        requestId: "tc-question-meta",
        questions: [{ text: "Pick databases", options: ["Postgres", "SQLite"] }],
      }])
      const tool = c.state.tools["tc-question-meta"]
      const snapshot = tool && eventMeta([{
        type: "tool-start",
        toolCallId: "tc-question-meta",
        toolName: "question",
        metadata: viewTool(tool).metadata,
      } as any], 0)
      expect(snapshot?.questionIds).toEqual(["q1"])
      expect(snapshot?.allowMultiple).toBe(true)
    })

    it("Cursor todo merge and cancelled status are preserved", () => {
      const c = ctx("cursor-acp")
      const result = translateSessionUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "tc-todo-meta",
        title: "Update TODOs",
        rawInput: {
          _toolName: "updateTodos",
          merge: true,
          todos: [{ id: "t1", content: "Check", status: "cancelled" }],
        },
      }, c)
      expect(result[0]).toMatchObject({
        type: "todo-update",
        todos: [{ description: "Check", status: "cancelled" }],
      })
      const snapshot = viewTool(c.state.tools["tc-todo-meta"]).metadata.acp as Record<string, unknown>
      expect(snapshot.todoMode).toBe("merge")
    })

    it("Cursor create-plan fields and task subagent metadata are preserved", () => {
      const createPlan = translateSessionUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "tc-plan-meta",
        title: "Create Plan",
        rawInput: {
          _toolName: "create_plan",
          plan: "Ship it",
          phases: [{ name: "Phase 1", todos: [] }],
          isProject: true,
        },
      }, ctx("cursor-acp"))
      expect(createPlan[0]).toMatchObject({ type: "tool-start", toolName: "plan" })
      expect(eventMeta(createPlan, 0)?.plan).toBe("Ship it")
      expect(eventMeta(createPlan, 0)?.isProject).toBe(true)

      const task = translateSessionUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "tc-task-meta",
        title: "Task: Subagent task",
        rawInput: {
          _toolName: "task",
          description: "Explore",
          subagentType: { custom: "schema-review" },
          agentId: "agent-1",
          durationMs: 42,
        },
      }, ctx("cursor-acp"))
      expect(eventMeta(task, 0)?.subagentType).toEqual({ custom: "schema-review" })
      expect(eventMeta(task, 0)?.agentId).toBe("agent-1")
      expect(eventMeta(task, 0)?.durationMs).toBe(42)
    })
  })
})

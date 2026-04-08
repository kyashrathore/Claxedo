/**
 * Codex ACP trace fixture: realistic sequence of SessionUpdate events.
 * Codex builds ACP-native ToolCall and ToolCallUpdate events directly.
 * Primary key is ACP-native event structure, secondary keys are parsed command type.
 */
import type { SessionUpdate } from "@agentclientprotocol/sdk"

export const codexTrace: SessionUpdate[] = [
  // 1. Text message
  {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "I'll examine the codebase." },
  },

  // 2. Shell (parsed command Unknown → shell)
  {
    sessionUpdate: "tool_call",
    toolCallId: "tc-codex-shell-1",
    title: "Run git status",
    kind: "execute",
    rawInput: {
      command: ["bash", "-lc", "git status"],
      parsed_cmd: [{ type: "shell", cmd: "git status" }],
    },
    content: undefined,
    locations: undefined,
  },
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "tc-codex-shell-1",
    status: "completed",
    rawInput: undefined,
    rawOutput: { stdout: "On branch main\nChanges not staged for commit:", stderr: "" },
    content: undefined,
    locations: undefined,
  },

  // 3. Read (parsed command Read)
  {
    sessionUpdate: "tool_call",
    toolCallId: "tc-codex-read-1",
    title: "Read /src/app.ts",
    kind: "read",
    rawInput: {
      filePath: "/src/app.ts",
      parsed_cmd: [{ type: "read", path: "/src/app.ts" }],
    },
    content: undefined,
    locations: [{ path: "/src/app.ts", line: 1 }],
  },
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "tc-codex-read-1",
    status: "completed",
    rawInput: undefined,
    rawOutput: { content: "import express from 'express'\nconst app = express()" },
    content: undefined,
    locations: undefined,
  },

  // 4. Edit (apply_patch style)
  {
    sessionUpdate: "tool_call",
    toolCallId: "tc-codex-edit-1",
    title: "Edit /src/app.ts",
    kind: "edit",
    rawInput: {
      filePath: "/src/app.ts",
    },
    content: [
      {
        type: "diff",
        path: "/src/app.ts",
        oldText: "const app = express()",
        newText: "const app = express()\napp.use(cors())",
      },
    ],
    locations: [{ path: "/src/app.ts", line: 2 }],
  },
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "tc-codex-edit-1",
    status: "completed",
    rawInput: undefined,
    rawOutput: null,
    content: undefined,
    locations: undefined,
  },

  // 5. Search (parsed command Search)
  {
    sessionUpdate: "tool_call",
    toolCallId: "tc-codex-search-1",
    title: "Search for middleware",
    kind: "search",
    rawInput: {
      parsed_cmd: [{ type: "search", query: "middleware", path: "/src" }],
    },
    content: undefined,
    locations: undefined,
  },
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "tc-codex-search-1",
    status: "completed",
    rawInput: undefined,
    rawOutput: { totalMatches: 7, truncated: false },
    content: undefined,
    locations: undefined,
  },

  // 6. List files (parsed command ListFiles)
  {
    sessionUpdate: "tool_call",
    toolCallId: "tc-codex-list-1",
    title: "List /src",
    kind: "search",
    rawInput: {
      parsed_cmd: [{ type: "list_files", path: "/src" }],
    },
    content: undefined,
    locations: undefined,
  },
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "tc-codex-list-1",
    status: "completed",
    rawInput: undefined,
    rawOutput: { totalFiles: 15, truncated: false },
    content: undefined,
    locations: undefined,
  },

  // 7. Delete
  {
    sessionUpdate: "tool_call",
    toolCallId: "tc-codex-delete-1",
    title: "Delete /src/legacy.ts",
    kind: "delete",
    rawInput: {
      filePath: "/src/legacy.ts",
    },
    content: undefined,
    locations: [{ path: "/src/legacy.ts" }],
  },
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "tc-codex-delete-1",
    status: "completed",
    rawInput: undefined,
    rawOutput: null,
    content: undefined,
    locations: undefined,
  },

  // 8. Permission request (session-surface: permission-request)
  {
    sessionUpdate: "tool_call",
    toolCallId: "tc-codex-perm-1",
    title: "Permission",
    rawInput: {
      _toolName: "permission",
      reason: "Need write access to modify files",
      scopes: ["/src", "/lib"],
    },
  },
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "tc-codex-perm-1",
    status: "completed",
    rawInput: undefined,
    rawOutput: "granted",
    content: undefined,
    locations: undefined,
  },

  // 9. Sparse update: tool_call with content, then in_progress with rawOutput, then completed with null
  {
    sessionUpdate: "tool_call",
    toolCallId: "tc-codex-sparse-1",
    title: "Run npm build",
    kind: "execute",
    rawInput: {
      command: ["bash", "-lc", "npm run build"],
      parsed_cmd: [{ type: "shell", cmd: "npm run build" }],
    },
    content: [{ type: "terminal", terminalId: "codex-term-1" }],
    locations: undefined,
  },
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "tc-codex-sparse-1",
    status: "in_progress",
    rawInput: undefined,
    rawOutput: { stdout: "compiling...", stderr: "" },
    content: undefined,
    locations: undefined,
  },
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "tc-codex-sparse-1",
    status: "completed",
    rawInput: undefined,
    rawOutput: null,
    content: undefined,
    locations: undefined,
  },

  // 9. Failed tool
  {
    sessionUpdate: "tool_call",
    toolCallId: "tc-codex-fail-1",
    title: "Read /nonexistent.ts",
    kind: "read",
    rawInput: {
      filePath: "/nonexistent.ts",
    },
    content: undefined,
    locations: [{ path: "/nonexistent.ts" }],
  },
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "tc-codex-fail-1",
    status: "failed",
    rawInput: undefined,
    rawOutput: "ENOENT: no such file or directory",
    content: undefined,
    locations: undefined,
  },
]

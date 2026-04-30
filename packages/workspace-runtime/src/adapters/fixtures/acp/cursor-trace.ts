/**
 * Cursor ACP trace fixture: realistic sequence of SessionUpdate events
 * representing a session with shell, read, edit, search, and delete tools.
 */
import type { SessionUpdate } from "@agentclientprotocol/sdk"

export const cursorTrace: SessionUpdate[] = [
  // 1. Text message
  {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "Let me check the project structure." },
  },

  // 2. Shell: git status
  {
    sessionUpdate: "tool_call",
    toolCallId: "tc-cursor-shell-1",
    title: "Terminal git status",
    kind: "execute",
    rawInput: {
      parsed_cmd: [{ type: "shell", cmd: "git status" }],
    },
    content: [{ type: "terminal", terminalId: "term-1" }],
    locations: undefined,
  },
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "tc-cursor-shell-1",
    status: "completed",
    rawInput: undefined,
    rawOutput: { stdout: "On branch main\nnothing to commit", stderr: "" },
    content: undefined,
    locations: undefined,
  },

  // 3. Read file
  {
    sessionUpdate: "tool_call",
    toolCallId: "tc-cursor-read-1",
    title: "Read File /src/index.ts",
    kind: "read",
    rawInput: null,
    content: undefined,
    locations: [{ path: "/src/index.ts", line: 1 }],
  },
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "tc-cursor-read-1",
    status: "completed",
    rawInput: undefined,
    rawOutput: { content: 'export function main() {\n  console.log("hello")\n}' },
    content: undefined,
    locations: undefined,
  },

  // 4. Edit file
  {
    sessionUpdate: "tool_call",
    toolCallId: "tc-cursor-edit-1",
    title: "Edit File /src/index.ts",
    kind: "edit",
    rawInput: null,
    content: [
      {
        type: "diff",
        path: "/src/index.ts",
        oldText: '  console.log("hello")',
        newText: '  console.log("world")',
      },
    ],
    locations: [{ path: "/src/index.ts", line: 2 }],
  },
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "tc-cursor-edit-1",
    status: "completed",
    rawInput: undefined,
    rawOutput: null,
    content: undefined,
    locations: undefined,
  },

  // 5. Find (glob)
  {
    sessionUpdate: "tool_call",
    toolCallId: "tc-cursor-find-1",
    title: "Find",
    kind: "search",
    rawInput: {
      parsed_cmd: [{ type: "glob", path: "/src", pattern: "*.ts" }],
    },
    content: undefined,
    locations: undefined,
  },
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "tc-cursor-find-1",
    status: "completed",
    rawInput: undefined,
    rawOutput: { totalFiles: 12, truncated: false },
    content: undefined,
    locations: undefined,
  },

  // 6. Grep
  {
    sessionUpdate: "tool_call",
    toolCallId: "tc-cursor-grep-1",
    title: "grep",
    kind: "search",
    rawInput: {
      parsed_cmd: [{ type: "search", query: "TODO", path: "/src" }],
    },
    content: undefined,
    locations: undefined,
  },
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "tc-cursor-grep-1",
    status: "completed",
    rawInput: undefined,
    rawOutput: { totalMatches: 3, truncated: false },
    content: undefined,
    locations: undefined,
  },

  // 7. Delete file
  {
    sessionUpdate: "tool_call",
    toolCallId: "tc-cursor-delete-1",
    title: "Delete File /src/old.ts",
    kind: "delete",
    rawInput: null,
    content: [
      {
        type: "diff",
        path: "/src/old.ts",
        oldText: "// old file content",
        newText: "",
      },
    ],
    locations: [{ path: "/src/old.ts" }],
  },
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "tc-cursor-delete-1",
    status: "completed",
    rawInput: undefined,
    rawOutput: null,
    content: undefined,
    locations: undefined,
  },

  // 8. Web Search
  {
    sessionUpdate: "tool_call",
    toolCallId: "tc-cursor-web-1",
    title: "Web Search",
    kind: "search",
    rawInput: { query: "TypeScript best practices 2025" },
    content: undefined,
    locations: undefined,
  },
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "tc-cursor-web-1",
    status: "completed",
    rawInput: undefined,
    rawOutput: { referenceCount: 5, truncated: false },
    content: undefined,
    locations: undefined,
  },

  // 9. Codebase Search
  {
    sessionUpdate: "tool_call",
    toolCallId: "tc-cursor-codebase-1",
    title: "Codebase Search",
    kind: "search",
    rawInput: { query: "authentication handler" },
    content: undefined,
    locations: undefined,
  },
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "tc-cursor-codebase-1",
    status: "completed",
    rawInput: undefined,
    rawOutput: { resultCount: 2, truncated: false },
    content: undefined,
    locations: undefined,
  },

  // 10. Update TODOs (session-surface: todo-update)
  {
    sessionUpdate: "tool_call",
    toolCallId: "tc-cursor-todos-1",
    title: "Update TODOs",
    rawInput: {
      _toolName: "updateTodos",
      todos: [{ content: "Refactor auth module", status: "in_progress", priority: "high" }],
    },
  },
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "tc-cursor-todos-1",
    status: "completed",
    rawInput: undefined,
    rawOutput: null,
    content: undefined,
    locations: undefined,
  },

  // 11. Ask Question (session-surface: question)
  {
    sessionUpdate: "tool_call",
    toolCallId: "tc-cursor-question-1",
    title: "Ask Question",
    rawInput: {
      _toolName: "askQuestion",
      prompt: "Which testing framework?",
      options: ["vitest", "jest"],
    },
  },
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "tc-cursor-question-1",
    status: "completed",
    rawInput: undefined,
    rawOutput: "vitest",
    content: undefined,
    locations: undefined,
  },

  // 12. Sparse update: completed with rawOutput:null but content
  {
    sessionUpdate: "tool_call",
    toolCallId: "tc-cursor-edit-sparse",
    title: "Edit File /src/utils.ts",
    kind: "edit",
    rawInput: null,
    content: [
      {
        type: "diff",
        path: "/src/utils.ts",
        oldText: "function old() {}",
        newText: "function updated() {}",
      },
    ],
    locations: [{ path: "/src/utils.ts", line: 5 }],
  },
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "tc-cursor-edit-sparse",
    status: "in_progress",
    rawInput: undefined,
    rawOutput: { partial: "writing changes..." },
    content: undefined,
    locations: undefined,
  },
  // Sparse completion: rawOutput is null — earlier rawOutput should be preserved in reducer
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "tc-cursor-edit-sparse",
    status: "completed",
    rawInput: undefined,
    rawOutput: null,
    content: undefined,
    locations: undefined,
  },
]

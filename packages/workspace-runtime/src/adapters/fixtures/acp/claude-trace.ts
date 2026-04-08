/**
 * Claude ACP trace fixture: realistic sequence of SessionUpdate events
 * representing a session with Bash, Read, Edit, Write, Glob, Grep, WebSearch, WebFetch, Task tools.
 * Claude preserves `toolName` which is a stronger discriminator than `kind`.
 */
import type { SessionUpdate } from "@agentclientprotocol/sdk"

export const claudeTrace: SessionUpdate[] = [
  // 1. Text message
  {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "I'll start by reading the file." },
  },

  // 2. Bash (shell)
  {
    sessionUpdate: "tool_call",
    toolCallId: "tc-claude-bash-1",
    title: "Terminal ls -la /src",
    kind: "execute",
    rawInput: {
      _toolName: "Bash",
      command: "ls -la /src",
    },
    content: [{ type: "terminal", terminalId: "claude-term-1" }],
    locations: undefined,
  },
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "tc-claude-bash-1",
    status: "completed",
    rawInput: undefined,
    rawOutput: { stdout: "total 42\n-rw-r--r-- 1 user staff 1234 index.ts", stderr: "" },
    content: undefined,
    locations: undefined,
  },

  // 3. Read
  {
    sessionUpdate: "tool_call",
    toolCallId: "tc-claude-read-1",
    title: "Read /src/config.ts",
    kind: "read",
    rawInput: {
      _toolName: "Read",
      filePath: "/src/config.ts",
    },
    content: undefined,
    locations: [{ path: "/src/config.ts", line: 1 }],
  },
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "tc-claude-read-1",
    status: "completed",
    rawInput: undefined,
    rawOutput: { content: 'export const config = { port: 3000 }' },
    content: undefined,
    locations: undefined,
  },

  // 4. Edit
  {
    sessionUpdate: "tool_call",
    toolCallId: "tc-claude-edit-1",
    title: "Edit /src/config.ts",
    kind: "edit",
    rawInput: {
      _toolName: "Edit",
      filePath: "/src/config.ts",
    },
    content: [
      {
        type: "diff",
        path: "/src/config.ts",
        oldText: "port: 3000",
        newText: "port: 8080",
      },
    ],
    locations: [{ path: "/src/config.ts", line: 1 }],
  },
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "tc-claude-edit-1",
    status: "completed",
    rawInput: undefined,
    rawOutput: null,
    content: undefined,
    locations: undefined,
  },

  // 5. Write (create new file)
  {
    sessionUpdate: "tool_call",
    toolCallId: "tc-claude-write-1",
    title: "Write /src/helpers.ts",
    kind: "edit",
    rawInput: {
      _toolName: "Write",
      filePath: "/src/helpers.ts",
    },
    content: [
      {
        type: "diff",
        path: "/src/helpers.ts",
        oldText: "",
        newText: 'export function greet(name: string) {\n  return `Hello ${name}`\n}',
      },
    ],
    locations: [{ path: "/src/helpers.ts" }],
  },
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "tc-claude-write-1",
    status: "completed",
    rawInput: undefined,
    rawOutput: null,
    content: undefined,
    locations: undefined,
  },

  // 6. Glob
  {
    sessionUpdate: "tool_call",
    toolCallId: "tc-claude-glob-1",
    title: "Find",
    kind: "search",
    rawInput: {
      _toolName: "Glob",
      pattern: "**/*.test.ts",
      path: "/src",
    },
    content: undefined,
    locations: undefined,
  },
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "tc-claude-glob-1",
    status: "completed",
    rawInput: undefined,
    rawOutput: { totalFiles: 8, truncated: false },
    content: undefined,
    locations: undefined,
  },

  // 7. Grep
  {
    sessionUpdate: "tool_call",
    toolCallId: "tc-claude-grep-1",
    title: "grep pattern=TODO",
    kind: "search",
    rawInput: {
      _toolName: "Grep",
      pattern: "TODO",
      path: "/src",
    },
    content: undefined,
    locations: undefined,
  },
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "tc-claude-grep-1",
    status: "completed",
    rawInput: undefined,
    rawOutput: { totalMatches: 5, truncated: false },
    content: undefined,
    locations: undefined,
  },

  // 8. WebSearch
  {
    sessionUpdate: "tool_call",
    toolCallId: "tc-claude-websearch-1",
    title: "Web Search",
    kind: "fetch",
    rawInput: {
      _toolName: "WebSearch",
      query: "bun test runner documentation",
    },
    content: undefined,
    locations: undefined,
  },
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "tc-claude-websearch-1",
    status: "completed",
    rawInput: undefined,
    rawOutput: { referenceCount: 10, truncated: false },
    content: undefined,
    locations: undefined,
  },

  // 9. WebFetch
  {
    sessionUpdate: "tool_call",
    toolCallId: "tc-claude-webfetch-1",
    title: "Fetch https://bun.sh/docs",
    kind: "fetch",
    rawInput: {
      _toolName: "WebFetch",
      url: "https://bun.sh/docs",
    },
    content: undefined,
    locations: undefined,
  },
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "tc-claude-webfetch-1",
    status: "completed",
    rawInput: undefined,
    rawOutput: { content: "Bun documentation page content..." },
    content: undefined,
    locations: undefined,
  },

  // 10. Agent/Task
  {
    sessionUpdate: "tool_call",
    toolCallId: "tc-claude-task-1",
    title: "Task: Run test suite",
    kind: "think",
    rawInput: {
      _toolName: "Agent",
      description: "Run the full test suite and report results",
    },
    content: undefined,
    locations: undefined,
  },
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "tc-claude-task-1",
    status: "completed",
    rawInput: undefined,
    rawOutput: { content: "All 42 tests passed." },
    content: undefined,
    locations: undefined,
  },

  // 11. TodoWrite (session-surface: todo-update)
  {
    sessionUpdate: "tool_call",
    toolCallId: "tc-claude-todowrite-1",
    title: "Update TODOs",
    kind: "think",
    rawInput: {
      _toolName: "TodoWrite",
      todos: [
        { content: "Implement auth", status: "in_progress", priority: "high" },
        { content: "Add tests", status: "pending", priority: "medium" },
      ],
    },
    content: undefined,
    locations: undefined,
  },
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "tc-claude-todowrite-1",
    status: "completed",
    rawInput: undefined,
    rawOutput: null,
    content: undefined,
    locations: undefined,
  },

  // 12. ExitPlanMode (session-surface: reasoning, suppressed)
  {
    sessionUpdate: "tool_call",
    toolCallId: "tc-claude-plan-1",
    title: "ExitPlanMode",
    kind: "other" as import("@agentclientprotocol/sdk").ToolKind,
    rawInput: { _toolName: "ExitPlanMode" },
    content: undefined,
    locations: undefined,
  },
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "tc-claude-plan-1",
    status: "completed",
    rawInput: undefined,
    rawOutput: null,
    content: undefined,
    locations: undefined,
  },

  // 13. Sparse update test: in_progress has rawOutput, completed sends null
  {
    sessionUpdate: "tool_call",
    toolCallId: "tc-claude-sparse-1",
    title: "Terminal npm test",
    kind: "execute",
    rawInput: {
      _toolName: "Bash",
      command: "npm test",
    },
    content: [{ type: "terminal", terminalId: "claude-term-2" }],
    locations: undefined,
  },
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "tc-claude-sparse-1",
    status: "in_progress",
    rawInput: undefined,
    rawOutput: { stdout: "running tests...", stderr: "" },
    content: undefined,
    locations: undefined,
  },
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "tc-claude-sparse-1",
    status: "completed",
    rawInput: undefined,
    rawOutput: null,
    content: undefined,
    locations: undefined,
  },
]

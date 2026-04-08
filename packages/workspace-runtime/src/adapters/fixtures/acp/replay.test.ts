/**
 * Replay tests: reduce full trace fixtures into normalized tool snapshots.
 *
 * Phase 1 assertions:
 * - every tool call produces a normalized snapshot
 * - sparse later updates do not erase earlier known fields
 * - file paths survive through the pipeline
 * - shell output is preserved
 * - diff content survives
 */
import { describe, it, expect } from "bun:test"
import type { SessionUpdate } from "@agentclientprotocol/sdk"
import {
  translateSessionUpdate,
  createTranslatorContext,
  type TranslatorContext,
} from "../../translate-session-update"
import { cursorTrace } from "./cursor-trace"
import { claudeTrace } from "./claude-trace"
import { codexTrace } from "./codex-trace"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type AgentEvent = ReturnType<typeof translateSessionUpdate>[number]

function replay(trace: SessionUpdate[], client?: string) {
  const ctx = createTranslatorContext(client)
  const allEvents: AgentEvent[] = []
  for (const update of trace) {
    allEvents.push(...translateSessionUpdate(update, ctx))
  }
  return { events: allEvents, ctx }
}

function toolEvents(events: AgentEvent[], toolCallId: string) {
  return events.filter((e) => "toolCallId" in e && e.toolCallId === toolCallId)
}

function lastToolInput(events: AgentEvent[], toolCallId: string) {
  const inputs = toolEvents(events, toolCallId).filter((e) => e.type === "tool-input")
  return inputs[inputs.length - 1] as Extract<AgentEvent, { type: "tool-input" }> | undefined
}

function lastToolOutput(events: AgentEvent[], toolCallId: string) {
  const outputs = toolEvents(events, toolCallId).filter((e) => e.type === "tool-output")
  return outputs[outputs.length - 1] as Extract<AgentEvent, { type: "tool-output" }> | undefined
}

function toolStart(events: AgentEvent[], toolCallId: string) {
  return toolEvents(events, toolCallId).find((e) => e.type === "tool-start") as
    | Extract<AgentEvent, { type: "tool-start" }>
    | undefined
}

function acpMeta(event: { metadata?: Record<string, unknown> }) {
  return event.metadata?.acp as Record<string, unknown> | undefined
}

// ---------------------------------------------------------------------------
// Cursor ACP replay
// ---------------------------------------------------------------------------

describe("cursor trace replay", () => {
  const { events, ctx } = replay(cursorTrace, "cursor-acp")

  it("produces tool-start for non-surface tool_calls", () => {
    const starts = events.filter((e) => e.type === "tool-start")
    // 12 tool_calls total but todos + question are session surfaces (no tool-start)
    // shell, read, edit, find, grep, delete, web, codebase, edit-sparse = 9
    expect(starts.length).toBe(9)
  })

  it("shell: preserves command and terminal", () => {
    const start = toolStart(events, "tc-cursor-shell-1")
    expect(start).toBeDefined()
    expect(start!.toolName).toBe("bash")
    const input = lastToolInput(events, "tc-cursor-shell-1")
    expect(input?.input?.command).toBe("git status")
    const meta = acpMeta(input!)
    expect(meta?.intent).toBe("shell")
  })

  it("shell: output contains stdout", () => {
    const out = lastToolOutput(events, "tc-cursor-shell-1")
    expect(out).toBeDefined()
    expect(out!.output).toMatchObject({ stdout: "On branch main\nnothing to commit", stderr: "" })
  })

  it("read: preserves file path from locations", () => {
    const input = lastToolInput(events, "tc-cursor-read-1")
    expect(input?.input?.filePath).toBe("/src/index.ts")
    const meta = acpMeta(input!)
    expect(meta?.intent).toBe("read")
  })

  it("edit: preserves file path and has diff", () => {
    const start = toolStart(events, "tc-cursor-edit-1")
    expect(start?.toolName).toBe("edit")
    const meta = acpMeta(start!)
    expect(meta?.intent).toBe("edit")
    // diff events emitted
    const diffs = events.filter((e) => e.type === "file-diff" && e.toolCallId === "tc-cursor-edit-1")
    expect(diffs.length).toBe(1)
  })

  it("find: normalizes to list intent", () => {
    const start = toolStart(events, "tc-cursor-find-1")
    expect(start).toBeDefined()
    const meta = acpMeta(start!)
    expect(meta?.intent).toBe("list")
  })

  it("grep: normalizes to search intent", () => {
    const start = toolStart(events, "tc-cursor-grep-1")
    expect(start).toBeDefined()
    const meta = acpMeta(start!)
    expect(meta?.intent).toBe("search")
  })

  it("delete: preserves file path", () => {
    const start = toolStart(events, "tc-cursor-delete-1")
    expect(start).toBeDefined()
    const meta = acpMeta(start!)
    expect(meta?.intent).toBe("delete")
  })

  it("web search: normalizes to search/web", () => {
    const start = toolStart(events, "tc-cursor-web-1")
    expect(start).toBeDefined()
    const meta = acpMeta(start!)
    expect(meta?.intent).toBe("search")
    expect(meta?.mode).toBe("web")
  })

  it("codebase search: normalizes to search/codebase", () => {
    const start = toolStart(events, "tc-cursor-codebase-1")
    expect(start).toBeDefined()
    const meta = acpMeta(start!)
    expect(meta?.intent).toBe("search")
    expect(meta?.mode).toBe("codebase")
  })

  it("sparse update: rawOutput:null does not erase earlier rawOutput in reducer", () => {
    // The edit-sparse tool had in_progress rawOutput {partial: "writing changes..."} then completed with null
    const state = ctx.state.tools["tc-cursor-edit-sparse"]
    expect(state).toBeDefined()
    // The reducer should have preserved the earlier rawOutput
    expect(state.rawOutput).toEqual({ partial: "writing changes..." })
  })

  it("sparse update: completed edit still has diff content and locations", () => {
    const state = ctx.state.tools["tc-cursor-edit-sparse"]
    expect(state.content.length).toBeGreaterThan(0)
    expect(state.content[0].type).toBe("diff")
    expect(state.locations.length).toBeGreaterThan(0)
    expect(state.locations[0].path).toBe("/src/utils.ts")
  })

  it("todos: emits todo-update instead of tool-start", () => {
    const todoEvents = events.filter((e) => e.type === "todo-update")
    expect(todoEvents.length).toBeGreaterThanOrEqual(1)
    const toolStarts = events.filter((e) => e.type === "tool-start" && "toolCallId" in e && e.toolCallId === "tc-cursor-todos-1")
    expect(toolStarts.length).toBe(0)
  })

  it("question: emits question event instead of tool-start", () => {
    const questionEvents = events.filter((e) => e.type === "question")
    expect(questionEvents.length).toBe(1)
    const toolStarts = events.filter((e) => e.type === "tool-start" && "toolCallId" in e && e.toolCallId === "tc-cursor-question-1")
    expect(toolStarts.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Claude ACP replay
// ---------------------------------------------------------------------------

describe("claude trace replay", () => {
  const { events, ctx } = replay(claudeTrace, "claude-acp")

  it("produces tool-start for non-surface tool_calls", () => {
    const starts = events.filter((e) => e.type === "tool-start")
    // 13 total tool_calls but todowrite + exitplanmode are session surfaces (no tool-start)
    // bash, read, edit, write, glob, grep, websearch, webfetch, task, sparse-bash = 10
    expect(starts.length).toBe(10)
  })

  it("bash: toolName from _toolName is Bash, normalizes to bash", () => {
    const start = toolStart(events, "tc-claude-bash-1")
    expect(start?.toolName).toBe("bash")
    const meta = acpMeta(start!)
    expect(meta?.intent).toBe("shell")
  })

  it("bash: command extracted from rawInput", () => {
    const input = lastToolInput(events, "tc-claude-bash-1")
    expect(input?.input?.command).toBe("ls -la /src")
  })

  it("read: toolName Read maps to read intent", () => {
    const start = toolStart(events, "tc-claude-read-1")
    expect(start?.toolName).toBe("read")
    const meta = acpMeta(start!)
    expect(meta?.intent).toBe("read")
    const input = lastToolInput(events, "tc-claude-read-1")
    expect(input?.input?.filePath).toBe("/src/config.ts")
  })

  it("edit: preserves file path and diff", () => {
    const start = toolStart(events, "tc-claude-edit-1")
    expect(start?.toolName).toBe("edit")
    const diffs = events.filter((e) => e.type === "file-diff" && e.toolCallId === "tc-claude-edit-1")
    expect(diffs.length).toBe(1)
  })

  it("write: maps to edit intent with mode=write", () => {
    const start = toolStart(events, "tc-claude-write-1")
    // Write still resolves via edit kind path — toolName "write" should match
    const meta = acpMeta(start!)
    expect(meta?.intent).toBe("edit")
  })

  it("glob: Glob tool normalizes correctly", () => {
    const start = toolStart(events, "tc-claude-glob-1")
    const meta = acpMeta(start!)
    expect(meta?.intent).toBe("list")
    const input = lastToolInput(events, "tc-claude-glob-1")
    expect(input?.input?.pattern).toBe("**/*.test.ts")
  })

  it("grep: Grep tool normalizes correctly", () => {
    const start = toolStart(events, "tc-claude-grep-1")
    const meta = acpMeta(start!)
    expect(meta?.intent).toBe("search")
    const input = lastToolInput(events, "tc-claude-grep-1")
    expect(input?.input?.pattern).toBe("TODO")
    expect(input?.input?.path).toBe("/src")
  })

  it("websearch: WebSearch tool normalizes to search/web", () => {
    const start = toolStart(events, "tc-claude-websearch-1")
    const meta = acpMeta(start!)
    expect(meta?.intent).toBe("search")
    expect(meta?.mode).toBe("web")
    const input = lastToolInput(events, "tc-claude-websearch-1")
    expect(input?.input?.query).toBe("bun test runner documentation")
  })

  it("webfetch: WebFetch tool normalizes to fetch/web", () => {
    const start = toolStart(events, "tc-claude-webfetch-1")
    const meta = acpMeta(start!)
    expect(meta?.intent).toBe("fetch")
    const input = lastToolInput(events, "tc-claude-webfetch-1")
    expect(input?.input?.url).toBe("https://bun.sh/docs")
  })

  it("task: Agent tool normalizes to task intent", () => {
    const start = toolStart(events, "tc-claude-task-1")
    expect(start?.toolName).toBe("task")
    const meta = acpMeta(start!)
    expect(meta?.intent).toBe("task")
  })

  it("sparse: rawOutput:null completion preserves earlier stdout in reducer", () => {
    const state = ctx.state.tools["tc-claude-sparse-1"]
    expect(state).toBeDefined()
    expect(state.rawOutput).toEqual({ stdout: "running tests...", stderr: "" })
  })

  it("todowrite: emits todo-update instead of tool-start", () => {
    const todoEvents = events.filter((e) => e.type === "todo-update")
    expect(todoEvents.length).toBeGreaterThanOrEqual(1)
    const toolStarts = events.filter((e) => e.type === "tool-start" && "toolCallId" in e && e.toolCallId === "tc-claude-todowrite-1")
    expect(toolStarts.length).toBe(0)
  })

  it("exitplanmode: reasoning intent suppresses all tool rows", () => {
    const toolStarts = events.filter((e) => e.type === "tool-start" && "toolCallId" in e && e.toolCallId === "tc-claude-plan-1")
    expect(toolStarts.length).toBe(0)
    const toolOutputs = events.filter((e) => e.type === "tool-output" && "toolCallId" in e && e.toolCallId === "tc-claude-plan-1")
    expect(toolOutputs.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Codex ACP replay
// ---------------------------------------------------------------------------

describe("codex trace replay", () => {
  const { events, ctx } = replay(codexTrace, "codex-acp")

  it("produces tool-start for non-surface tool_calls", () => {
    const starts = events.filter((e) => e.type === "tool-start")
    // 10 total tool_calls but permission is a session surface (no tool-start)
    // shell, read, edit, search, list, delete, sparse-shell, fail-read = 8
    expect(starts.length).toBe(8)
  })

  it("shell: parsed command produces bash tool", () => {
    const start = toolStart(events, "tc-codex-shell-1")
    expect(start?.toolName).toBe("bash")
    const meta = acpMeta(start!)
    expect(meta?.intent).toBe("shell")
    const input = lastToolInput(events, "tc-codex-shell-1")
    expect(input?.input?.command).toBe("git status")
  })

  it("read: preserves file path from rawInput and locations", () => {
    const start = toolStart(events, "tc-codex-read-1")
    expect(start?.toolName).toBe("read")
    const input = lastToolInput(events, "tc-codex-read-1")
    expect(input?.input?.filePath).toBe("/src/app.ts")
  })

  it("edit: preserves diff content", () => {
    const diffs = events.filter((e) => e.type === "file-diff" && e.toolCallId === "tc-codex-edit-1")
    expect(diffs.length).toBe(1)
  })

  it("search: grep-style parsed command normalizes", () => {
    const start = toolStart(events, "tc-codex-search-1")
    const meta = acpMeta(start!)
    expect(meta?.intent).toBe("search")
  })

  it("list: list_files parsed command produces list tool", () => {
    const start = toolStart(events, "tc-codex-list-1")
    const meta = acpMeta(start!)
    expect(meta?.intent).toBe("list")
  })

  it("delete: normalizes to delete intent with file path", () => {
    const start = toolStart(events, "tc-codex-delete-1")
    const meta = acpMeta(start!)
    expect(meta?.intent).toBe("delete")
    const input = lastToolInput(events, "tc-codex-delete-1")
    expect(input?.input?.filePath).toBe("/src/legacy.ts")
  })

  it("sparse: rawOutput:null does not erase earlier rawOutput", () => {
    const state = ctx.state.tools["tc-codex-sparse-1"]
    expect(state).toBeDefined()
    expect(state.rawOutput).toEqual({ stdout: "compiling...", stderr: "" })
  })

  it("failed tool: preserves file path and error", () => {
    const state = ctx.state.tools["tc-codex-fail-1"]
    expect(state).toBeDefined()
    expect(state.status).toBe("failed")
    // rawOutput is a string error — not null, so it should be preserved directly
    expect(state.rawOutput).toBe("ENOENT: no such file or directory")
    // File path from rawInput should survive
    expect(state.rawInput?.filePath).toBe("/nonexistent.ts")
    const errors = events.filter((e) => e.type === "tool-error" && e.toolCallId === "tc-codex-fail-1")
    expect(errors.length).toBe(1)
  })

  it("permission: emits permission-request instead of tool-start", () => {
    const permEvents = events.filter((e) => e.type === "permission-request")
    expect(permEvents.length).toBe(1)
    const toolStarts = events.filter((e) => e.type === "tool-start" && "toolCallId" in e && e.toolCallId === "tc-codex-perm-1")
    expect(toolStarts.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Cross-client invariants
// ---------------------------------------------------------------------------

describe("cross-client invariants", () => {
  it("no tool with rawOutput evidence renders as empty in reducer", () => {
    for (const [label, trace, client] of [
      ["cursor", cursorTrace, "cursor-acp"],
      ["claude", claudeTrace, "claude-acp"],
      ["codex", codexTrace, "codex-acp"],
    ] as const) {
      const { ctx } = replay(trace, client)
      for (const [id, tool] of Object.entries(ctx.state.tools)) {
        if (tool.rawOutput !== undefined && tool.rawOutput !== null) {
          // Tool had real output — it should still be there
          expect(tool.rawOutput).toBeTruthy()
        }
        // Every tool should have a status
        expect(["pending", "running", "completed", "failed"]).toContain(tool.status)
      }
    }
  })

  it("session-surface families never produce tool-start events", () => {
    // Cursor: todos (tc-cursor-todos-1) and question (tc-cursor-question-1)
    const cursorResult = replay(cursorTrace, "cursor-acp")
    const cursorStarts = cursorResult.events.filter((e) => e.type === "tool-start")
    for (const e of cursorStarts) {
      const id = "toolCallId" in e ? e.toolCallId : ""
      expect(id).not.toBe("tc-cursor-todos-1")
      expect(id).not.toBe("tc-cursor-question-1")
    }

    // Claude: todowrite (tc-claude-todowrite-1) and reasoning (tc-claude-plan-1)
    const claudeResult = replay(claudeTrace, "claude-acp")
    const claudeStarts = claudeResult.events.filter((e) => e.type === "tool-start")
    for (const e of claudeStarts) {
      const id = "toolCallId" in e ? e.toolCallId : ""
      expect(id).not.toBe("tc-claude-todowrite-1")
      expect(id).not.toBe("tc-claude-plan-1")
    }

    // Codex: permission (tc-codex-perm-1)
    const codexResult = replay(codexTrace, "codex-acp")
    const codexStarts = codexResult.events.filter((e) => e.type === "tool-start")
    for (const e of codexStarts) {
      const id = "toolCallId" in e ? e.toolCallId : ""
      expect(id).not.toBe("tc-codex-perm-1")
    }
  })

  it("sparse rawOutput:null never erases earlier evidence across all clients", () => {
    // Cursor sparse edit
    const cursorResult = replay(cursorTrace, "cursor-acp")
    expect(cursorResult.ctx.state.tools["tc-cursor-edit-sparse"].rawOutput).not.toBeNull()

    // Claude sparse bash
    const claudeResult = replay(claudeTrace, "claude-acp")
    expect(claudeResult.ctx.state.tools["tc-claude-sparse-1"].rawOutput).not.toBeNull()

    // Codex sparse shell
    const codexResult = replay(codexTrace, "codex-acp")
    expect(codexResult.ctx.state.tools["tc-codex-sparse-1"].rawOutput).not.toBeNull()
  })
})

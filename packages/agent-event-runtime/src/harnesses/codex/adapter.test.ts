import { describe, expect, test } from "bun:test"
import { createAgentEventRuntime } from "../../core/runtime"
import type { RuntimeSnapshot } from "../../core/state"
import {
  codexAppServerAdapter,
  codexCollabAgentCall,
  codexCollabAgentStatus,
  codexStartedSubagent,
  codexSubagentActivity,
  type CodexAppServerAdapterState,
} from "./adapter"

function runtime(initialSnapshot?: RuntimeSnapshot<CodexAppServerAdapterState>) {
  return createAgentEventRuntime({
    harness: "codex-app-server",
    threadId: "thread-1",
    adapter: codexAppServerAdapter(),
    clock: () => 0,
    createId: (prefix = "id") => `${prefix}-1`,
    ...(initialSnapshot ? { initialSnapshot } : {}),
  })
}

describe("codexAppServerAdapter", () => {
  test("translates native plan progress into canonical task status", () => {
    const agent = runtime()
    const result = agent.ingest({
      source: "codex.app-server",
      method: "turn/plan/updated",
      payload: {
        threadId: "thread-1",
        turnId: "turn-1",
        plan: [
          { step: "Inspect source", status: "completed" },
          { step: "Verify behavior", status: "inProgress" },
          { step: "Report result", status: "pending" },
        ],
      },
    })
    expect(result.events).toMatchObject([{
      type: "todo-update",
      todos: [
        { id: "0", description: "Inspect source", status: "completed" },
        { id: "1", description: "Verify behavior", status: "in_progress" },
        { id: "2", description: "Report result", status: "pending" },
      ],
    }])
  })

  test("keeps native subagent activity bound to the spawn call without rendering a second completion tool", () => {
    const agent = runtime()
    const started = { type: "subAgentActivity", id: "spawn-call", kind: "started", agentThreadId: "child-thread", agentPath: "/root/child" }
    expect(codexSubagentActivity(started)).toEqual({ id: "spawn-call", kind: "started", agentThreadId: "child-thread", agentPath: "/root/child" })
    expect(agent.ingest({ source: "codex.app-server", method: "item/started", payload: { item: started } }).events)
      .toContainEqual(expect.objectContaining({ type: "tool-start", toolCallId: "spawn-call", toolName: "subagent" }))
    const completed = { ...started, id: "subagent-completed-event", kind: "completed" }
    for (const method of ["item/started", "item/completed"]) {
      expect(agent.ingest({ source: "codex.app-server", method, payload: { item: completed } }).events).toEqual([])
    }
    expect(codexSubagentActivity({ ...started, agentThreadId: undefined })).toBeUndefined()
  })

  test("maps assistant deltas and completed message snapshots without duplicating text", () => {
    const agent = runtime()

    expect(agent.ingest({
      source: "codex.app-server",
      method: "item/agentMessage/delta",
      payload: { itemId: "msg-1", delta: "hel" },
    }).events).toMatchObject([{ type: "text-delta", delta: "hel" }])

    expect(agent.ingest({
      source: "codex.app-server",
      method: "item/completed",
      payload: { item: { id: "msg-1", type: "agentMessage", text: "hello" } },
    }).events).toMatchObject([{ type: "text-delta", delta: "lo" }])
  })

  test("restores active assistant item text without duplicating completed snapshots", () => {
    const first = runtime()
    first.ingest({
      source: "codex.app-server",
      method: "item/agentMessage/delta",
      payload: { itemId: "msg-1", delta: "hel" },
    })

    const restored = runtime(first.snapshot())

    expect(restored.ingest({
      source: "codex.app-server",
      method: "item/completed",
      payload: { item: { id: "msg-1", type: "agentMessage", text: "hello" } },
    }).events).toMatchObject([{ type: "text-delta", delta: "lo" }])
    expect(restored.snapshot().adapterState.assistantTextByItemId["msg-1"]).toBe("hello")
  })

  test("maps reasoning and proposed plan streams", () => {
    const agent = runtime()

    expect(agent.ingest({
      source: "codex.app-server",
      method: "item/reasoning/textDelta",
      payload: { delta: "Think" },
    }).events).toMatchObject([{ type: "thinking-delta", delta: "Think" }])

    expect(agent.ingest({
      source: "codex.app-server",
      method: "item/plan/delta",
      payload: { delta: "- inspect" },
    }).events).toMatchObject([{ type: "proposed-plan-delta", delta: "- inspect" }])

    expect(agent.ingest({
      source: "codex.app-server",
      method: "item/completed",
      payload: { item: { id: "plan-1", type: "plan", text: "## Plan" } },
    }).events).toMatchObject([{ type: "proposed-plan-complete", planMarkdown: "## Plan" }])
  })

  test("maps approvals and requestUserInput lifecycle events", () => {
    const agent = runtime()

    expect(agent.ingest({
      source: "codex.app-server",
      method: "item/commandExecution/requestApproval",
      payload: { requestId: "approval-1", command: "rm -rf tmp", cwd: "/repo", reason: "Remove generated files" },
    }).events).toMatchObject([{
      type: "permission-request",
      requestId: "approval-1",
      tool: "command",
      paths: ["/repo"],
      details: { command: "rm -rf tmp", reason: "Remove generated files" },
    }])

    expect(agent.ingest({
      source: "codex.app-server",
      method: "item/permissions/requestApproval",
      payload: { requestId: "approval-2", toolName: "Edit", paths: ["/repo/file.ts"] },
    }).events).toMatchObject([{
      type: "permission-request",
      requestId: "approval-2",
      tool: "Edit",
      paths: ["/repo/file.ts"],
    }])

    expect(agent.ingest({
      source: "codex.app-server",
      method: "item/tool/requestUserInput",
      payload: {
        requestId: "question-1",
        questions: [{
          id: "sandbox_mode",
          question: "Which mode?",
          options: [{ label: "workspace-write", description: "Allow workspace writes" }],
        }],
      },
    }).events).toMatchObject([{
      type: "question",
      requestId: "question-1",
      questions: [{ text: "Which mode?", options: ["workspace-write"], optionDescriptions: { "workspace-write": "Allow workspace writes" } }],
    }])

  })

  test("completes tool-like items even when app-server only sends item/completed", () => {
    const agent = runtime()

    expect(agent.ingest({
      source: "codex.app-server",
      method: "item/completed",
      payload: {
        item: {
          id: "cmd-1",
          type: "commandExecution",
          command: "git status",
          cwd: "/repo",
          output: "clean",
        },
      },
    }).events).toMatchObject([
      { type: "tool-start", toolCallId: "cmd-1", toolName: "command", kind: "command_execution" },
      { type: "tool-input", toolCallId: "cmd-1", input: { command: "git status", cwd: "/repo" } },
      { type: "tool-output", toolCallId: "cmd-1", output: "clean" },
    ])
  })

  for (const started of [false, true]) {
    test(`nonzero command completion emits an error with native output (started=${started})`, () => {
      const agent = runtime()
      const item = { id: "failed-command", type: "commandExecution", command: "node fail.cjs", cwd: "/repo" }
      if (started) agent.ingest({ source: "codex.app-server", method: "item/started", payload: { item } })
      const events = agent.ingest({ source: "codex.app-server", method: "item/completed", payload: {
        item: { ...item, status: "failed", exitCode: 23, aggregatedOutput: "EXPECTED_TOOL_FAILURE" },
      } }).events
      expect(events).toContainEqual(expect.objectContaining({ type: "tool-error", toolCallId: "failed-command", error: "EXPECTED_TOOL_FAILURE" }))
      expect(events.some((event) => event.type === "tool-output")).toBe(false)
    })
  }

  test("a completion carries Codex's exit code for the row to render", () => {
    const agent = runtime()
    const failed = agent.ingest({ source: "codex.app-server", method: "item/completed", payload: {
      item: {
        id: "missing-binary",
        type: "commandExecution",
        command: "grep needle haystack",
        cwd: "/repo",
        status: "failed",
        exitCode: 127,
        aggregatedOutput: "zsh: command not found: grep",
      },
    } }).events
    expect(failed).toContainEqual(expect.objectContaining({
      type: "tool-error",
      toolCallId: "missing-binary",
      error: "zsh: command not found: grep",
      metadata: { exitCode: 127, codex: { itemType: "command_execution" } },
    }))

    const passed = agent.ingest({ source: "codex.app-server", method: "item/completed", payload: {
      item: {
        id: "matched",
        type: "commandExecution",
        command: "grep needle haystack",
        cwd: "/repo",
        status: "completed",
        exitCode: 0,
        aggregatedOutput: "needle",
      },
    } }).events
    expect(passed).toContainEqual(expect.objectContaining({
      type: "tool-output",
      toolCallId: "matched",
      metadata: { exitCode: 0, codex: { itemType: "command_execution" } },
    }))
  })

  test("a declined command is an error naming the decline, not a silent success", () => {
    const agent = runtime()
    const events = agent.ingest({ source: "codex.app-server", method: "item/completed", payload: {
      item: {
        id: "declined-command",
        type: "commandExecution",
        command: "rm -rf /repo",
        cwd: "/repo",
        status: "declined",
        aggregatedOutput: null,
      },
    } }).events
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool-error",
      toolCallId: "declined-command",
      error: "User declined the command",
    }))
    expect(events.some((event) => event.type === "tool-output")).toBe(false)
  })

  test("a process exit reports the code's verdict", () => {
    const failed = runtime().ingest({ source: "codex.app-server", method: "process/exited", payload: {
      processHandle: "proc-killed",
      exitCode: 137,
      stdout: "",
      stderr: "",
    } }).events
    expect(failed).toContainEqual(expect.objectContaining({
      type: "tool-error",
      toolCallId: "proc-killed",
      error: "Process exited with code 137",
      metadata: expect.objectContaining({ exitCode: 137 }),
    }))
    expect(failed.some((event) => event.type === "tool-output")).toBe(false)

    const passed = runtime().ingest({ source: "codex.app-server", method: "process/exited", payload: {
      processHandle: "proc-ok",
      exitCode: 0,
      stdout: "done",
      stderr: "",
    } }).events
    expect(passed).toContainEqual(expect.objectContaining({ type: "tool-output", toolCallId: "proc-ok", output: "done" }))
    expect(passed.some((event) => event.type === "tool-error")).toBe(false)
  })

  test("a command that produced no output yields empty output, not the raw envelope", () => {
    const agent = runtime()

    // Real shape observed from `ls` in an empty dir: every output field is null, so the
    // old `?? row` fallback dumped the entire protocol payload into the tool output pane.
    const events = agent.ingest({
      source: "codex.app-server",
      method: "item/completed",
      payload: {
        item: {
          id: "call_9wdI50",
          type: "commandExecution",
          command: "/bin/zsh -lc ls",
          cwd: "/tmp/workspace",
          processId: "4512",
          source: "unifiedExecStartup",
          status: "completed",
          commandActions: [{ type: "listFiles", command: "ls", path: null }],
          aggregatedOutput: null,
          exitCode: 0,
          durationMs: 0,
        },
        threadId: "thread-1",
        turnId: "turn-1",
        completedAtMs: 1784357339346,
      },
    }).events

    const event = events.find((item) => item.type === "tool-output")
    expect(event).toBeDefined()
    const output = event && "output" in event ? event.output : undefined
    expect(output).toBe("")
    // The `output` field is what reaches the UI's output pane — it must carry no protocol
    // noise. (Events also keep a `raw` copy of the source event for traceability; that is
    // by design and is deliberately not asserted against here.)
    expect(JSON.stringify(output)).not.toContain("commandExecution")
    expect(JSON.stringify(output)).not.toContain("unifiedExecStartup")
  })

  test("completion preserves already-streamed output when aggregatedOutput is null", () => {
    const agent = runtime()

    agent.ingest({
      source: "codex.app-server",
      method: "item/started",
      payload: {
        item: { id: "cmd-1", type: "commandExecution", command: "ls -la", cwd: "/repo", status: "running" },
        threadId: "thread-1",
        turnId: "turn-1",
      },
    })
    agent.ingest({
      source: "codex.app-server",
      method: "item/commandExecution/outputDelta",
      payload: { threadId: "thread-1", turnId: "turn-1", itemId: "cmd-1", delta: "total 0\n.generated" },
    })

    // Codex streams stdout via outputDelta and then completes with aggregatedOutput: null.
    // The completion must NOT blank out what already streamed.
    const events = agent.ingest({
      source: "codex.app-server",
      method: "item/completed",
      payload: {
        item: {
          id: "cmd-1",
          type: "commandExecution",
          command: "ls -la",
          cwd: "/repo",
          status: "completed",
          aggregatedOutput: null,
          exitCode: 0,
        },
        threadId: "thread-1",
        turnId: "turn-1",
      },
    }).events

    const event = events.find((item) => item.type === "tool-output")
    const output = event && "output" in event ? event.output : undefined
    expect(output).toBe("total 0\n.generated")
  })

  test("maps lower-level command output streams to running tool content", () => {
    const agent = runtime()

    expect(agent.ingest({
      source: "codex.app-server",
      method: "item/started",
      payload: {
        item: {
          id: "cmd-1",
          type: "commandExecution",
          command: "bun test",
          cwd: "/repo",
          processId: "pty-1",
          source: "agent",
          status: "running",
          commandActions: [],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
        threadId: "thread-1",
        turnId: "turn-1",
        startedAtMs: 0,
      },
    }).events).toMatchObject([
      { type: "tool-start", toolCallId: "cmd-1", toolName: "command" },
      { type: "tool-input", toolCallId: "cmd-1", input: { command: "bun test", cwd: "/repo", processId: "pty-1" } },
    ])

    expect(agent.ingest({
      source: "codex.app-server",
      method: "item/commandExecution/outputDelta",
      payload: { threadId: "thread-1", turnId: "turn-1", itemId: "cmd-1", delta: "pass" },
    }).events).toMatchObject([{
      type: "tool-content",
      toolCallId: "cmd-1",
      content: { type: "content", content: { type: "text", text: "pass" } },
    }])

    expect(agent.ingest({
      source: "codex.app-server",
      method: "item/commandExecution/outputDelta",
      payload: { threadId: "thread-1", turnId: "turn-1", itemId: "cmd-1", delta: "ed" },
    }).events).toMatchObject([{
      type: "tool-content",
      toolCallId: "cmd-1",
      content: { type: "content", content: { type: "text", text: "passed" } },
    }])
  })

  test("maps standalone process streams and exit notifications", () => {
    const agent = runtime()

    expect(agent.ingest({
      source: "codex.app-server",
      method: "process/outputDelta",
      payload: {
        processHandle: "proc-1",
        stream: "stdout",
        deltaBase64: Buffer.from("hello").toString("base64"),
        capReached: false,
      },
    }).events).toMatchObject([
      { type: "tool-start", toolCallId: "proc-1", toolName: "process" },
      { type: "tool-input", toolCallId: "proc-1", input: { processHandle: "proc-1", stream: "stdout" } },
      {
        type: "tool-content",
        toolCallId: "proc-1",
        content: { type: "content", content: { type: "text", text: "hello" } },
      },
    ])

    expect(agent.ingest({
      source: "codex.app-server",
      method: "process/exited",
      payload: {
        processHandle: "proc-1",
        exitCode: 0,
        stdout: "",
        stdoutCapReached: false,
        stderr: "",
        stderrCapReached: false,
      },
    }).events).toMatchObject([{
      type: "tool-output",
      toolCallId: "proc-1",
      output: "hello",
    }])
  })

  test("decodes process output in browser-like runtimes without Buffer", () => {
    const agent = runtime()
    const runtimeGlobal = globalThis as typeof globalThis & { Buffer?: typeof Buffer }
    const original = runtimeGlobal.Buffer
    try {
      Object.defineProperty(runtimeGlobal, "Buffer", {
        configurable: true,
        value: undefined,
      })

      expect(agent.ingest({
        source: "codex.app-server",
        method: "process/outputDelta",
        payload: {
          processHandle: "proc-1",
          stream: "stdout",
          deltaBase64: "aGVsbG8=",
          capReached: false,
        },
      }).events).toMatchObject([{
        type: "tool-start",
        toolCallId: "proc-1",
      }, {
        type: "tool-input",
        toolCallId: "proc-1",
      }, {
        type: "tool-content",
        toolCallId: "proc-1",
        content: { type: "content", content: { type: "text", text: "hello" } },
      }])
    } finally {
      Object.defineProperty(runtimeGlobal, "Buffer", {
        configurable: true,
        value: original,
      })
    }
  })

  test("maps file patch stream updates to file diffs", () => {
    const agent = runtime()

    expect(agent.ingest({
      source: "codex.app-server",
      method: "item/fileChange/patchUpdated",
      payload: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "patch-1",
        changes: [{ path: "src/app.ts", kind: "update", diff: "@@ -1 +1 @@" }],
      },
    }).events).toMatchObject([
      { type: "tool-start", toolCallId: "patch-1", toolName: "file-change", kind: "file_change" },
      { type: "file-diff", toolCallId: "patch-1", path: "src/app.ts", newText: "@@ -1 +1 @@" },
    ])
  })

  test("ignores user message item echoes", () => {
    const agent = runtime()

    expect(agent.ingest({
      source: "codex.app-server",
      method: "item/started",
      payload: {
        item: {
          id: "user-1",
          type: "userMessage",
          content: [{ type: "text", text: "Reply with exactly OK.", text_elements: [] }],
        },
      },
    }).events).toEqual([])

    expect(agent.ingest({
      source: "codex.app-server",
      method: "item/completed",
      payload: {
        item: {
          id: "user-1",
          type: "userMessage",
          content: [{ type: "text", text: "Reply with exactly OK.", text_elements: [] }],
        },
      },
    }).events).toEqual([])
  })

  test("maps usage and terminal lifecycle events", () => {
    const agent = runtime()

    expect(agent.ingest({
      source: "codex.app-server",
      method: "turn/started",
      payload: { turn: { id: "turn-1", status: "inProgress" } },
    }).events).toMatchObject([{ type: "session-status", status: "busy" }])

    expect(agent.ingest({
      source: "codex.app-server",
      method: "thread/tokenUsage/updated",
      payload: {
        tokenUsage: {
          total: { totalTokens: 11839, inputTokens: 10000, cachedInputTokens: 7000, outputTokens: 1200, reasoningOutputTokens: 639 },
          last: { totalTokens: 126, inputTokens: 100, cachedInputTokens: 60, outputTokens: 20, reasoningOutputTokens: 6 },
          modelContextWindow: 258400,
        },
      },
    }).events).toMatchObject([{
      type: "usage",
      contextSize: 258400,
      contextUsed: 126,
      observation: {
        kind: "cumulative",
        nativeSessionId: "thread-1",
        tokens: {
          input: 40,
          output: 14,
          reasoning: 6,
          cache: { read: 60, write: null },
        },
      },
    }])

    expect(agent.ingest({
      source: "codex.app-server",
      method: "turn/completed",
      payload: { sessionId: "session-1", turn: { status: "completed" } },
    }).events).toMatchObject([
      { type: "session-status", status: "idle" },
      { type: "finish", sessionId: "session-1" },
    ])
  })

  test("accumulates usage across every request of a turn and resets on turn boundaries", () => {
    const agent = runtime()
    const tokenUsageEvent = (total: Record<string, number>, last: Record<string, number>) =>
      agent.ingest({
        source: "codex.app-server",
        method: "thread/tokenUsage/updated",
        payload: { tokenUsage: { total, last, modelContextWindow: 258400 } },
      })

    // Request 1 of the turn: no prior totals, so the per-request `last` seeds
    // the turn accumulator.
    expect(tokenUsageEvent(
      { totalTokens: 11839, inputTokens: 10000, cachedInputTokens: 7000, outputTokens: 1200, reasoningOutputTokens: 639 },
      { totalTokens: 126, inputTokens: 100, cachedInputTokens: 60, outputTokens: 20, reasoningOutputTokens: 6 },
    ).events).toMatchObject([{
      type: "usage",
      observation: { kind: "cumulative", tokens: { input: 40, output: 14, reasoning: 6, cache: { read: 60, write: null } } },
    }])

    // Request 2: the totals moved by 500/400/100/21 while `last` claims only
    // 200/150/40/8 (a missed emission). The totals difference is authoritative
    // and the observation is the TURN total, not the last request.
    expect(tokenUsageEvent(
      { totalTokens: 12460, inputTokens: 10500, cachedInputTokens: 7400, outputTokens: 1300, reasoningOutputTokens: 660 },
      { totalTokens: 398, inputTokens: 200, cachedInputTokens: 150, outputTokens: 40, reasoningOutputTokens: 8 },
    ).events).toMatchObject([{
      type: "usage",
      // accumulated raw: input 600, cached 460, output 120, reasoning 27
      observation: { kind: "cumulative", tokens: { input: 140, output: 93, reasoning: 27, cache: { read: 460, write: null } } },
    }])

    // A re-emission with unchanged totals is the same request again: it still
    // refreshes the context meter but must not carry a metering observation.
    const duplicate = tokenUsageEvent(
      { totalTokens: 12460, inputTokens: 10500, cachedInputTokens: 7400, outputTokens: 1300, reasoningOutputTokens: 660 },
      { totalTokens: 398, inputTokens: 200, cachedInputTokens: 150, outputTokens: 40, reasoningOutputTokens: 8 },
    ).events
    expect(duplicate).toMatchObject([{ type: "usage", contextUsed: 398 }])
    expect((duplicate[0] as { observation?: unknown }).observation).toBeUndefined()

    agent.ingest({
      source: "codex.app-server",
      method: "turn/completed",
      payload: { sessionId: "session-1", turn: { status: "completed" } },
    })

    // First request of the NEXT turn: the accumulator restarted, and the
    // cross-turn totals difference must not leak in — `last` seeds again.
    expect(tokenUsageEvent(
      { totalTokens: 12720, inputTokens: 10700, cachedInputTokens: 7600, outputTokens: 1400, reasoningOutputTokens: 670 },
      { totalTokens: 160, inputTokens: 100, cachedInputTokens: 100, outputTokens: 50, reasoningOutputTokens: 10 },
    ).events).toMatchObject([{
      type: "usage",
      observation: { kind: "cumulative", tokens: { input: 0, output: 40, reasoning: 10, cache: { read: 100, write: null } } },
    }])
  })

  test("prunes turn-scoped resume state on terminal turn events", () => {
    const agent = runtime()

    agent.ingest({
      source: "codex.app-server",
      method: "item/agentMessage/delta",
      payload: { itemId: "msg-1", delta: "hel" },
    })
    agent.ingest({
      source: "codex.app-server",
      method: "item/started",
      payload: { item: { id: "cmd-1", type: "commandExecution", command: "bun test" } },
    })
    agent.ingest({
      source: "codex.app-server",
      method: "item/commandExecution/outputDelta",
      payload: { itemId: "cmd-1", delta: "pass" },
    })

    expect(Object.keys(agent.snapshot().adapterState.assistantTextByItemId)).toEqual(["msg-1"])
    expect(Object.keys(agent.snapshot().adapterState.toolsByItemId)).toEqual(["cmd-1"])
    expect(Object.keys(agent.snapshot().adapterState.toolOutputByCallId)).toEqual(["cmd-1"])

    agent.ingest({
      source: "codex.app-server",
      method: "turn/completed",
      payload: { sessionId: "session-1", turn: { status: "completed" } },
    })

    expect(agent.snapshot().adapterState).toEqual({
      assistantTextByItemId: {},
      toolOutputByCallId: {},
      toolsByItemId: {},
    })
  })

  test("maps retryable provider errors to diagnostics", () => {
    const agent = runtime()

    expect(agent.ingest({
      source: "codex.app-server",
      method: "error",
      payload: { error: { message: "Reconnecting... 2/5" }, willRetry: true },
    }).events).toMatchObject([{
      type: "diagnostic",
      diagnostic: {
        code: "codex_app_server.retryable_error",
        message: "Reconnecting... 2/5",
        severity: "warn",
      },
    }])
  })

  test("maps chat-adjacent app-server session/provider events first class", () => {
    const agent = runtime()

    expect(agent.ingest({
      source: "codex.app-server",
      method: "thread/compacted",
      payload: { threadId: "thread-1", turnId: "turn-1" },
    }).events).toMatchObject([{
      type: "session-compaction",
      phase: "completed",
    }])

    expect(agent.ingest({
      source: "codex.app-server",
      method: "account/rateLimits/updated",
      payload: {
        rateLimits: {
          limitId: "primary",
          limitName: "Primary",
          primary: { usedPercent: 95, windowDurationMins: 300, resetsAt: 1234 },
          rateLimitReachedType: "rate_limit_reached",
        },
      },
    }).events).toMatchObject([{
      type: "rate-limit",
      status: "limited",
      usedPercent: 95,
      reason: "rate_limit_reached",
    }])

    expect(agent.ingest({
      source: "codex.app-server",
      method: "mcpServer/startupStatus/updated",
      payload: { name: "docs", status: "failed", error: "boom" },
    }).events).toMatchObject([{
      type: "mcp-server-status",
      serverName: "docs",
      status: "failed",
      error: "boom",
    }])

    expect(agent.ingest({
      source: "codex.app-server",
      method: "warning",
      payload: { threadId: "thread-1", message: "Careful" },
    }).events).toMatchObject([{
      type: "harness-notice",
      code: "codex_app_server.warning",
      message: "Careful",
      severity: "warn",
    }])
  })

  test("retains rate-limit evidence without terminalizing an early systemError", () => {
    const agent = runtime()

    agent.ingest({
      source: "codex.app-server",
      method: "account/rateLimits/updated",
      payload: {
        rateLimits: {
          limitId: "primary",
          limitName: "Primary",
          primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1234 },
          rateLimitReachedType: "rate_limit_reached",
        },
      },
    })

    expect(agent.snapshot().adapterState.lastLimitedRateLimitMessage)
      .toBe("You've reached your Codex rate limit. It will reset in about 5 hours.")

    expect(agent.ingest({
      source: "codex.app-server", method: "thread/status/changed",
      payload: { threadId: "thread-1", status: { type: "systemError" } },
    }).events).toEqual([])
  })

  test("waits for the authoritative error after an early systemError", () => {
    const agent = runtime()
    expect(agent.ingest({
      source: "codex.app-server", method: "thread/status/changed",
      payload: { threadId: "thread-1", status: { type: "systemError" } },
    }).events).toEqual([])
    expect(agent.ingest({
      source: "codex.app-server", method: "error",
      payload: { threadId: "thread-1", turnId: "turn-1", willRetry: false,
        error: { message: "Provider rejected this request. Choose another model." } },
    }).events).toMatchObject([
      { type: "session-status", status: "error" },
      { type: "error", error: "Provider rejected this request. Choose another model." },
    ])
  })

  test("maps a Codex usageLimitExceeded turn error instead of the generic session error", () => {
    expect(runtime().ingest({
      source: "codex.app-server",
      method: "error",
      payload: {
        threadId: "thread-1",
        turnId: "turn-1",
        willRetry: false,
        error: {
          message: "session error",
          codexErrorInfo: "usageLimitExceeded",
          additionalDetails: "It will reset in about 5 hours.",
        },
      },
    }).events).toMatchObject([
      { type: "session-status", status: "error" },
      { type: "error", error: "You've reached your Codex usage limit. It will reset in about 5 hours." },
    ])
  })

  test("stamps the last Codex usage-limit sentence onto a failed turn after prune", () => {
    const agent = runtime()

    agent.ingest({
      source: "codex.app-server",
      method: "account/rateLimits/updated",
      payload: {
        rateLimits: {
          limitId: "primary",
          limitName: "Primary",
          primary: { usedPercent: 100, windowDurationMins: 300 },
          rateLimitReachedType: "workspace_owner_usage_limit_reached",
        },
      },
    })
    agent.ingest({
      source: "codex.app-server",
      method: "turn/completed",
      payload: { turn: { id: "turn-1", status: "completed" } },
    })

    expect(agent.snapshot().adapterState.lastLimitedRateLimitMessage)
      .toBe("You've reached your Codex usage limit. It will reset in about 5 hours.")

    expect(agent.ingest({
      source: "codex.app-server",
      method: "turn/completed",
      payload: { turn: { id: "turn-2", status: "failed" } },
    }).events).toMatchObject([
      { type: "session-status", status: "error" },
      { type: "error", error: "You've reached your Codex usage limit. It will reset in about 5 hours." },
    ])
  })

  test("classifies collab calls by their real tool and preserves every receiver edge", () => {
    expect(codexCollabAgentCall({
      id: "call-1",
      type: "collabAgentToolCall",
      tool: "sendInput",
      status: "inProgress",
      senderThreadId: "thread-parent",
      receiverThreadIds: ["thread-child-1", "thread-child-2"],
      prompt: "Continue",
      agentsStates: {
        "thread-child-1": { status: "running", message: null },
        "thread-child-2": { status: "pendingInit", message: null },
      },
    })).toEqual({
      id: "call-1",
      tool: "sendInput",
      toolCallRole: "interaction",
      senderThreadId: "thread-parent",
      receiverThreadIds: ["thread-child-1", "thread-child-2"],
      prompt: "Continue",
      statuses: {
        "thread-child-1": "running",
        "thread-child-2": "pending",
      },
    })

    expect(codexCollabAgentCall({
      id: "call-2",
      type: "collabAgentToolCall",
      tool: "spawnAgent",
      senderThreadId: "thread-parent",
      receiverThreadIds: ["thread-child-1"],
      agentsStates: {},
    })?.toolCallRole).toBe("spawn")
  })

  test("normalizes every Codex collab status without collapsing terminal states", () => {
    expect([
      "pendingInit",
      "running",
      "interrupted",
      "completed",
      "errored",
      "shutdown",
      "notFound",
    ].map(codexCollabAgentStatus)).toEqual([
      "pending",
      "running",
      "interrupted",
      "completed",
      "failed",
      "killed",
      "failed",
    ])
  })

  test("maps thread/name/updated's threadName to a session title", () => {
    const agent = runtime()
    expect(agent.ingest({
      source: "codex.app-server",
      method: "thread/name/updated",
      payload: { threadId: "thread-1", threadName: "Fix terminal pane" },
    }).events).toMatchObject([{ type: "session-title", title: "Fix terminal pane" }])
    expect(agent.ingest({
      source: "codex.app-server",
      method: "thread/name/updated",
      payload: { threadId: "thread-1" },
    }).events).toEqual([])
  })

  test("maps thread/started parent identity without emitting a parent diagnostic", () => {
    const payload = {
      thread: {
        id: "thread-child",
        parentThreadId: "thread-parent",
        preview: "Inspect the adapter",
        agentNickname: "Ada",
        agentRole: "reviewer",
        status: { type: "active", activeFlags: [] },
      },
    }
    expect(codexStartedSubagent(payload)).toEqual({
      id: "thread-child",
      parentThreadId: "thread-parent",
      status: "running",
      label: "Ada",
      subagentType: "reviewer",
      description: "Inspect the adapter",
    })
    expect(runtime().ingest({
      source: "codex.app-server",
      method: "thread/started",
      payload,
    }).events).toEqual([])
  })

  test("reports app-server methods that have no runtime mapping", () => {
    const agent = runtime()

    expect(agent.ingest({
      source: "codex.app-server",
      method: "hook/started",
      payload: { threadId: "thread-1", turnId: "turn-1", run: { id: "hook-1" } },
    }).events).toMatchObject([{
      type: "diagnostic",
      diagnostic: {
        code: "codex_app_server.unmapped_event",
        message: "hook/started: Codex app-server method has no AgentRuntimeEvent mapping",
        severity: "info",
      },
    }])
  })

  test("reports unknown app-server methods without throwing", () => {
    const agent = runtime()

    expect(agent.ingest({
      source: "codex.app-server",
      method: "future/newNotification",
      payload: { ok: true },
    }).events).toMatchObject([{
      type: "diagnostic",
      diagnostic: {
        code: "codex_app_server.unmapped_event",
        message: "future/newNotification: Codex app-server method has no AgentRuntimeEvent mapping",
        severity: "info",
      },
    }])
  })

  for (const started of [false, true]) {
    test(`MCP application error uses failed status and result content (started=${started})`, () => {
      const agent = runtime()
      const item = { id: "mcp-missing-session", type: "mcpToolCall", server: "claxedo", tool: "session_get", arguments: { session: "missing" }, pluginId: null }
      if (started) agent.ingest({ source: "codex.app-server", method: "item/started", payload: { item: { ...item, status: "inProgress" } } })
      const events = agent.ingest({ source: "codex.app-server", method: "item/completed", payload: { item: {
        ...item, status: "failed", result: { content: [{ type: "text", text: "Session not found" }], structuredContent: null, _meta: null }, error: null,
      } } }).events
      expect(events).toContainEqual(expect.objectContaining({ type: "tool-error", toolCallId: item.id, error: "Session not found" }))
      expect(events.some((event) => event.type === "tool-output")).toBe(false)
    })

    test(`MCP rejection remains a tool error (started=${started})`, () => {
      const agent = runtime()
      const item = { id: "mcp-rejected", type: "mcpToolCall", server: "composio", tool: "COMPOSIO_SEARCH_TOOLS", arguments: { queries: [] }, pluginId: null }
      if (started) agent.ingest({ source: "codex.app-server", method: "item/started", payload: { item: { ...item, status: "inProgress" } } })
      const events = agent.ingest({ source: "codex.app-server", method: "item/completed", payload: { item: {
        ...item, status: "failed", result: null, error: { message: "MCP authorization expired" },
      } } }).events
      expect(events).toContainEqual(expect.objectContaining({ type: "tool-error", toolCallId: item.id, error: "MCP authorization expired" }))
      expect(events.some((event) => event.type === "tool-output")).toBe(false)
    })
  }

  test("preserves MCP server, plugin identity and nested arguments when completion arrives without start", () => {
    const input = { server: "plugin:composio:composio", tool: "COMPOSIO_SEARCH_TOOLS", pluginId: "composio@claxedo-agent-plugins", arguments: { queries: [{ use_case: "Read profile" }], session: { id: "search-session" } } }
    const events = runtime().ingest({ source: "codex.app-server", method: "item/completed", payload: { item: {
      id: "composio-search", type: "mcpToolCall", ...input, status: "completed", result: { content: [{ type: "text", text: "discovered" }] }, error: null,
    } } }).events
    expect(events).toMatchObject([
      { type: "tool-start", toolName: "COMPOSIO_SEARCH_TOOLS" },
      { type: "tool-input", input },
      { type: "tool-output" },
    ])
  })

  test("carries MCP image content and a dynamic tool call's data-url image as attachments", () => {
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQ=="
    const mcp = runtime().ingest({ source: "codex.app-server", method: "item/completed", payload: { item: {
      id: "mcp-shot", type: "mcpToolCall", server: "browser", tool: "screenshot", pluginId: null, arguments: {}, status: "completed", error: null,
      result: { content: [{ type: "text", text: "captured" }, { type: "image", data: png, mimeType: "image/png" }] },
    } } }).events
    expect(mcp.at(-1)).toMatchObject({
      type: "tool-output",
      toolCallId: "mcp-shot",
      output: { content: [{ type: "text", text: "captured" }, { type: "image", data: png, mimeType: "image/png" }] },
      attachments: [{ kind: "inline", mime: "image/png", url: `data:image/png;base64,${png}` }],
    })

    const dynamic = runtime().ingest({ source: "codex.app-server", method: "item/completed", payload: { item: {
      id: "dyn-shot", type: "dynamicToolCall", namespace: null, tool: "capture", arguments: {}, status: "completed", success: true,
      contentItems: [
        { type: "inputText", text: "captured" },
        { type: "inputImage", imageUrl: `data:image/jpeg;base64,${png}` },
        { type: "inputImage", imageUrl: "https://example.test/shot.png" },
      ],
    } } }).events
    expect(dynamic.at(-1)).toMatchObject({
      type: "tool-output",
      toolCallId: "dyn-shot",
      attachments: [{ kind: "inline", mime: "image/jpeg", url: `data:image/jpeg;base64,${png}` }],
    })
  })

  test("leaves a text-only MCP result attachment-free", () => {
    const events = runtime().ingest({ source: "codex.app-server", method: "item/completed", payload: { item: {
      id: "mcp-text", type: "mcpToolCall", server: "claxedo", tool: "session_list", pluginId: null, arguments: {}, status: "completed", error: null,
      result: { content: [{ type: "text", text: "one session" }] },
    } } }).events
    expect(events.at(-1)).toMatchObject({ type: "tool-output", toolCallId: "mcp-text" })
    expect(events.at(-1)).not.toHaveProperty("attachments")
  })

  test("classifies a create_subagent MCP item as task work by its tool name", () => {
    const agent = runtime()
    expect(agent.ingest({
      source: "codex.app-server",
      method: "item/started",
      payload: {
        item: {
          id: "mcp-spawn-1",
          type: "mcpToolCall",
          server: "claxedo",
          tool: "create_subagent",
          status: "inProgress",
          arguments: { harness: "claude", prompt: "Consult on the plan" },
        },
      },
    }).events).toMatchObject([
      { type: "tool-start", toolCallId: "mcp-spawn-1", toolName: "create_subagent", kind: "mcp_tool_call", display: { intent: "task" } },
      { type: "tool-input", toolCallId: "mcp-spawn-1", input: { server: "claxedo", tool: "create_subagent", arguments: { harness: "claude", prompt: "Consult on the plan" } } },
    ])
    expect(agent.ingest({
      source: "codex.app-server",
      method: "item/started",
      payload: {
        item: { id: "mcp-other-1", type: "mcpToolCall", server: "claxedo", tool: "session_list", status: "inProgress", arguments: {} },
      },
    }).events).toMatchObject([
      { type: "tool-start", toolCallId: "mcp-other-1", toolName: "session_list", display: { intent: "mcp" } },
      { type: "tool-input", toolCallId: "mcp-other-1", input: { server: "claxedo", tool: "session_list", arguments: {} } },
    ])
  })
})

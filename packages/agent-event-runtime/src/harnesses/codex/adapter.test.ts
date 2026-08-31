import { describe, expect, test } from "bun:test"
import { createAgentEventRuntime } from "../../core/runtime"
import type { RuntimeSnapshot } from "../../core/state"
import {
  codexAppServerAdapter,
  codexCollabAgentCall,
  codexCollabAgentStatus,
  codexStartedSubagent,
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
      payload: { requestId: "approval-1", command: "rm -rf tmp", cwd: "/repo" },
    }).events).toMatchObject([{
      type: "permission-request",
      requestId: "approval-1",
      tool: "command",
      paths: ["/repo"],
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
      questions: [{ text: "Which mode?", options: ["workspace-write"] }],
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

  test("stamps the last Codex usage-limit sentence onto a later systemError", () => {
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
      source: "codex.app-server",
      method: "thread/status/changed",
      payload: { threadId: "thread-1", status: { type: "systemError" } },
    }).events).toMatchObject([
      { type: "session-status", status: "error" },
      { type: "error", error: "You've reached your Codex rate limit. It will reset in about 5 hours." },
    ])
  })

  test("keeps a generic systemError when no usage limit has fired", () => {
    expect(runtime().ingest({
      source: "codex.app-server",
      method: "thread/status/changed",
      payload: { threadId: "thread-1", status: { type: "systemError" } },
    }).events).toMatchObject([
      { type: "session-status", status: "error" },
      { type: "error", error: "session error" },
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
})

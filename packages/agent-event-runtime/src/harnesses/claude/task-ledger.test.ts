import { describe, expect, test } from "bun:test"
import { createClaudeTaskLedger } from "./task-ledger"

describe("createClaudeTaskLedger", () => {
  test("knows a task only from the frame that introduced it", () => {
    const ledger = createClaudeTaskLedger()
    expect(ledger.get("task-1")).toBeUndefined()
    expect(ledger.get(undefined)).toBeUndefined()

    ledger.start({ taskId: "task-1", toolUseId: "tool-agent-1", harnessExecutionId: "sdk-1", isAgentTask: true, skipTranscript: false })
    expect(ledger.get("task-1")).toEqual({
      taskId: "task-1",
      toolUseId: "tool-agent-1",
      harnessExecutionId: "sdk-1",
      isAgentTask: true,
      skipTranscript: false,
    })
  })

  test("reports the known tasks that left the live set, and nothing for the ones that stayed", () => {
    const ledger = createClaudeTaskLedger()
    ledger.start({ taskId: "task-1", isAgentTask: true, skipTranscript: false })
    ledger.start({ taskId: "task-2", isAgentTask: false, skipTranscript: false })

    expect(ledger.replaceLive(["task-1", "task-2"])).toEqual([])
    expect(ledger.replaceLive(["task-2"])).toEqual([
      { taskId: "task-1", isAgentTask: true, skipTranscript: false },
    ])
    expect(ledger.replaceLive(["task-2"])).toEqual([])
    expect(ledger.replaceLive([])).toEqual([
      { taskId: "task-2", isAgentTask: false, skipTranscript: false },
    ])
  })

  test("carries a task that joined the live set before it was introduced", () => {
    const ledger = createClaudeTaskLedger()
    expect(ledger.replaceLive(["task-1", "task-unknown"])).toEqual([])
    ledger.start({ taskId: "task-1", isAgentTask: true, skipTranscript: false })

    expect(ledger.replaceLive([])).toEqual([
      { taskId: "task-1", isAgentTask: true, skipTranscript: false },
    ])
  })
})

describe("createClaudeTaskLedger host subagent calls", () => {
  test("knows a create_subagent call only from the tool_use that made it", () => {
    const ledger = createClaudeTaskLedger()
    expect(ledger.isHostSubagentCall("tool-mcp-spawn-1")).toBe(false)
    ledger.startHostSubagentCall("tool-mcp-spawn-1")
    expect(ledger.isHostSubagentCall("tool-mcp-spawn-1")).toBe(true)
    expect(ledger.isHostSubagentCall("tool-bash-1")).toBe(false)
  })
})

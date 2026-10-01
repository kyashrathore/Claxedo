import { describe, expect, test } from "bun:test"
import { createClaudeTaskLedger } from "./task-ledger"

describe("createClaudeTaskLedger", () => {
  test("knows a task only from the frame that introduced it", () => {
    const ledger = createClaudeTaskLedger()
    expect(ledger.get("task-1")).toBeUndefined()
    expect(ledger.get(undefined)).toBeUndefined()

    ledger.start({ taskId: "task-1", toolUseId: "tool-agent-1", isAgentTask: true, skipTranscript: false })
    expect(ledger.get("task-1")).toEqual({
      taskId: "task-1",
      toolUseId: "tool-agent-1",
      isAgentTask: true,
      skipTranscript: false,
    })
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

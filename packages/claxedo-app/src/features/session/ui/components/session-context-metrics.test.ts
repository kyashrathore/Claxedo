import { expect, test } from "bun:test"
import type { AgentAssistantMessage } from "@claxedo/agent-runtime-contract"
import { getSessionContextMetrics } from "./session-context-metrics"

test("agent-owned model omission retains reported token usage without inventing model metadata", () => {
  const message: AgentAssistantMessage = {
    id: "assistant", sessionID: "session", role: "assistant", parentID: "user", time: { created: 1 },
    mode: "build", agent: "build", path: { cwd: "/repo", root: "/repo" }, cost: 0,
    tokens: { input: 10, output: 3, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  const result = getSessionContextMetrics([message], [])
  expect(result.context?.total).toBe(13)
  expect(result.context?.providerLabel).toBeUndefined()
  expect(result.context?.modelLabel).toBeUndefined()
  expect(result.context?.limit).toBeUndefined()
  expect(result.context?.usage).toBeNull()
})

import assert from "node:assert/strict"
import { test } from "node:test"
import { assertAgentExecutionBinding, AgentRuntimeContractError, agentReviewFileDiffList } from "@claxedo/agent-runtime-contract"

// node:test resolves the returned promise itself and reports failures through the runner.
void test("the published entry runs under Node without a TypeScript loader", () => {
  const binding = {
    sessionId: "session-1",
    workspaceId: "workspace-1",
    directory: "/work/one",
    connectionId: "native:pi",
    upstreamSessionId: "pi-1",
  }
  assert.equal(assertAgentExecutionBinding(binding), binding)
  assert.throws(() => assertAgentExecutionBinding({ ...binding, upstreamSessionId: "" }), AgentRuntimeContractError)
  const diff = { file: "main.ts", additions: 1, deletions: 0 }
  assert.deepEqual(agentReviewFileDiffList([diff, null]), [diff])
})

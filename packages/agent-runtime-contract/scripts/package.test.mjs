import assert from "node:assert/strict"
import { test } from "node:test"
import { assertAgentExecutionBinding, AgentRuntimeContractError } from "@claxedo/agent-runtime-contract"

test("the published entry runs under Node without a TypeScript loader", () => {
  const binding = { scope: "central", directory: "", sessionId: "central-1", connectionId: "native:pi", upstreamSessionId: "pi-1" }
  assert.equal(assertAgentExecutionBinding(binding), binding)
  assert.throws(() => assertAgentExecutionBinding({ ...binding, upstreamSessionId: "" }), AgentRuntimeContractError)
})

import assert from "node:assert/strict"
import { test } from "node:test"
import { requireAgentExecutionBinding, AgentRuntimeContractError, agentReviewFileDiffList } from "@claxedo/agent-runtime-contract"
import {
  agentRuntimeEvent,
  assistantMessageIdForTurn,
  userMessageIdForAssistantReply,
  EVENT_STREAM_HEARTBEAT_MS,
  normalizeDiagnostics,
  rawHarnessEvent,
} from "@claxedo/agent-runtime-contract"

// node:test resolves the returned promise itself and reports failures through the runner.
void test("the published entry runs under Node without a TypeScript loader", () => {
  const binding = {
    sessionId: "session-1",
    workspaceId: "workspace-1",
    directory: "/work/one",
    connectionId: "native:pi",
    upstreamSessionId: "pi-1",
  }
  assert.equal(requireAgentExecutionBinding(binding), binding)
  assert.throws(() => requireAgentExecutionBinding({ ...binding, upstreamSessionId: "" }), AgentRuntimeContractError)
  const diff = { file: "main.ts", additions: 1, deletions: 0 }
  assert.deepEqual(agentReviewFileDiffList([diff, null]), [diff])
})

void test("the published entry owns runtime event construction and stream identities", () => {
  const raw = rawHarnessEvent({ source: "provider", payload: { text: "hello" } })
  const event = agentRuntimeEvent.textDelta({ delta: "hello", raw })
  assert.equal(event.type, "text-delta")
  assert.equal(event.raw, raw)
  assert.throws(() => rawHarnessEvent({ source: "", payload: null }), /source is required/)
  assert.equal(userMessageIdForAssistantReply(assistantMessageIdForTurn("prompt-1")), "prompt-1")
  assert.equal(userMessageIdForAssistantReply("foreign-id"), undefined)
  assert.equal(EVENT_STREAM_HEARTBEAT_MS, 10_000)
  assert.deepEqual(normalizeDiagnostics([{ code: "provider.error", message: "Failed", severity: "error" }]), [
    { code: "provider.error", message: "Failed", severity: "error" },
  ])
})

import { expect, test } from "bun:test"
import { SdkRuntimeInteractions } from "./sdk-runtime-interactions"
import type { SdkRuntimeStore } from "./sdk-runtime-driver"

function rejectingStore(): SdkRuntimeStore {
  return {
    listQuestions: () => [{ id: "question-1", sessionID: "session-1", questions: [] }],
    listPermissions: () => [{ id: "permission-1", sessionID: "session-1" }],
    appendEvent: () => { throw new Error("durable write failed") },
  } as unknown as SdkRuntimeStore
}

test("question replies remain retryable when persistence fails", () => {
  const interactions = new SdkRuntimeInteractions(rejectingStore())
  interactions.questions.set("question-1", {
    sessionId: "session-1",
    agentSessionId: "agent-1",
    questions: [],
    resolve() {},
    reject() {},
  })

  expect(() => interactions.replyQuestion("question-1", "answer")).toThrow("durable write failed")
  expect(interactions.questions.has("question-1")).toBe(true)
  expect(interactions.listQuestions("/work")).toHaveLength(1)
})

test("permission cancellation remains retryable when persistence fails", () => {
  const interactions = new SdkRuntimeInteractions(rejectingStore())
  interactions.permissions.set("permission-1", {
    sessionId: "session-1",
    agentSessionId: "agent-1",
    method: "permission",
    params: {},
    resolve() {},
  })

  expect(() => interactions.resolvePermissions("session-1")).toThrow("durable write failed")
  expect(interactions.permissions.has("permission-1")).toBe(true)
  expect(interactions.listPermissions("/work")).toHaveLength(1)
})

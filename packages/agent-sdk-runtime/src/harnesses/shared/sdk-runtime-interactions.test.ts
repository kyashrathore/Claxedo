import { expect, test } from "bun:test"
import { SdkRuntimeInteractions } from "./sdk-runtime-interactions"
import type { SdkRuntimeStore } from "./sdk-runtime-driver"
import { executionBinding } from "../../test-utils/execution-binding"

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

  expect(() => interactions.replyQuestion(executionBinding("session-1", "/work"), "question-1", [["answer"]]))
    .toThrow("durable write failed")
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

for (const [sessionId, directory] of [["other-session", "/work"], ["session-1", "/other-workspace"]]) {
  test(`permission replies from ${sessionId} in ${directory} cannot consume another pending request`, () => {
    const decisions: string[] = []
    const committed: unknown[] = []
    const store = {
      listPermissions: (dir: string) => dir === "/work" ? [{ id: "permission-1", sessionID: "session-1" }] : [],
      appendEvent: (input: { payload: unknown }) => { committed.push(input); return input },
    } as unknown as SdkRuntimeStore
    const interactions = new SdkRuntimeInteractions(store)
    interactions.permissions.set("permission-1", {
      sessionId: "session-1", agentSessionId: "agent-1", method: "permission", params: {},
      resolve: (decision) => decisions.push(decision),
    })
    expect(() => interactions.respondPermission(executionBinding(sessionId, directory), "permission-1", "allow_always"))
      .toThrow()
    expect(decisions).toEqual([])
    expect(committed).toEqual([])
    expect(interactions.permissions.has("permission-1")).toBe(true)
    interactions.respondPermission(executionBinding("session-1", "/work"), "permission-1", "allow_once")
    expect(decisions).toEqual(["allow_once"])
    expect(committed).toHaveLength(1)
    expect(interactions.permissions.has("permission-1")).toBe(false)
  })
}

test("permission approval remains pending when the reply cannot be committed", () => {
  let resolved = false
  const interactions = new SdkRuntimeInteractions(rejectingStore())
  interactions.permissions.set("permission-1", {
    sessionId: "session-1", agentSessionId: "agent-1", method: "permission", params: {},
    resolve() { resolved = true },
  })
  expect(() => interactions.respondPermission(executionBinding("session-1", "/work"), "permission-1", "allow_always"))
    .toThrow("durable write failed")
  expect(resolved).toBe(false)
  expect(interactions.permissions.has("permission-1")).toBe(true)
})

test("question cancellation commits rejection and only consumes the stopped session", () => {
  const events: unknown[] = []
  const rejected: string[] = []
  const interactions = new SdkRuntimeInteractions({
    appendEvent: (event: { payload: unknown }) => { events.push(event.payload); return event },
  } as unknown as SdkRuntimeStore)
  for (const id of ["owner", "sibling"]) {
    interactions.questions.set(id, {
      sessionId: id, agentSessionId: `agent-${id}`, questions: [],
      resolve() {}, reject: () => { rejected.push(id) },
    })
  }
  interactions.rejectQuestions("owner")
  expect(rejected).toEqual(["owner"])
  expect(interactions.questions.has("owner")).toBe(false)
  expect(interactions.questions.has("sibling")).toBe(true)
  expect(events).toEqual([expect.objectContaining({ type: "question.rejected", properties: { sessionID: "owner", requestID: "owner" } })])
})

test("question cancellation preserves a pending request when persistence fails", () => {
  const interactions = new SdkRuntimeInteractions(rejectingStore())
  let rejected = false
  interactions.questions.set("question-1", {
    sessionId: "session-1", agentSessionId: "agent-1", questions: [],
    resolve() {}, reject: () => { rejected = true },
  })
  expect(() => interactions.rejectQuestions("session-1")).toThrow("durable write failed")
  expect(rejected).toBe(false)
  expect(interactions.questions.has("question-1")).toBe(true)
})

for (const operation of ["reply", "reject"] as const) {
  for (const [sessionId, directory] of [["other-session", "/work"], ["session-1", "/other-workspace"]]) {
    test(`question ${operation} from ${sessionId} in ${directory} preserves another owner's request`, () => {
      const decisions: string[] = []
      const committed: unknown[] = []
      const interactions = new SdkRuntimeInteractions({
        listQuestions: (dir: string) => dir === "/work" ? [{ id: "question-1", sessionID: "session-1", questions: [] }] : [],
        appendEvent: (event: { payload: unknown }) => { committed.push(event); return event },
      } as unknown as SdkRuntimeStore)
      interactions.questions.set("question-1", {
        sessionId: "session-1", agentSessionId: "agent-1", questions: [],
        resolve: () => { decisions.push("reply") }, reject: () => { decisions.push("reject") },
      })
      const respond = (binding: ReturnType<typeof executionBinding>) => operation === "reply"
        ? interactions.replyQuestion(binding, "question-1", [["Staging"]])
        : interactions.rejectQuestion(binding, "question-1")
      expect(() => respond(executionBinding(sessionId, directory))).toThrow()
      expect(decisions).toEqual([])
      expect(committed).toEqual([])
      expect(interactions.questions.has("question-1")).toBe(true)
      respond(executionBinding("session-1", "/work"))
      expect(decisions).toEqual([operation])
      expect(committed).toHaveLength(1)
      expect(interactions.questions.has("question-1")).toBe(false)
    })
  }
}

for (const options of [undefined, [], [{ id: "provider-specific", label: "Remember for this workspace" }]]) {
  test(`provider option validation preserves pending permission until a supported reply: ${JSON.stringify(options)}`, () => {
    const decisions: unknown[] = []
    const events: unknown[] = []
    const interactions = new SdkRuntimeInteractions({
      listPermissions: () => [{ id: "permission-1", sessionID: "session-1", options }],
      appendEvent: (event: { payload: unknown }) => { events.push(event.payload); return event },
    } as unknown as SdkRuntimeStore)
    interactions.permissions.set("permission-1", {
      sessionId: "session-1", agentSessionId: "agent-1", method: "permission", params: {},
      resolve: (decision, optionId) => decisions.push({ decision, optionId }),
    })
    const binding = executionBinding("session-1", "/work")
    expect(() => interactions.respondPermission(binding, "permission-1", "allow_once", "unknown")).toThrow()
    if (options !== undefined) {
      expect(() => interactions.respondPermission(binding, "permission-1", "allow_once")).toThrow()
    }
    expect(events).toEqual([])
    expect(decisions).toEqual([])
    expect(interactions.permissions.has("permission-1")).toBe(true)
    if (!options?.length) return
    interactions.respondPermission(binding, "permission-1", "allow_once", "provider-specific")
    expect(decisions).toEqual([{ decision: "allow_once", optionId: "provider-specific" }])
    expect(events).toEqual([expect.objectContaining({ type: "permission.replied", properties: { sessionID: "session-1", requestID: "permission-1", optionId: "provider-specific" } })])
    expect(interactions.permissions.has("permission-1")).toBe(false)
  })
}

test("all-question shutdown keeps an uncommitted rejection live", () => {
  const interactions = new SdkRuntimeInteractions(rejectingStore())
  let rejected = false
  interactions.questions.set("question-1", { sessionId: "session-1", agentSessionId: "agent-1", questions: [], resolve() {}, reject() { rejected = true } })
  expect(() => interactions.rejectAllQuestions()).toThrow("durable write failed")
  expect(rejected).toBe(false)
  expect(interactions.questions.has("question-1")).toBe(true)
})

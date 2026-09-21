import { expect, test } from "bun:test"
import { createMemoryRuntimeStore } from "../../stores/memory"
import { finalizeAuthoredTurn, registerTurnAuthority, TurnAuthorityUnavailableError } from "./turn-authority"

function session(id: string) {
  const store = createMemoryRuntimeStore()
  store.bindSession({ sessionId: id, directory: "/work", agentSessionId: `agent-${id}` })
  return store
}

test("a domain that cannot claim the session's lease gets no authority to write with", () => {
  const store = session("s1")
  const first = registerTurnAuthority(store, "acp_goal", { sessionId: "s1", assistantMessageId: "asst-1" })
  expect(first).toBeDefined()

  // Two owners projecting one session is what the lease exists to prevent.
  expect(registerTurnAuthority(store, "provider_child", { sessionId: "s1", assistantMessageId: "asst-2" })).toBeUndefined()
  expect(new TurnAuthorityUnavailableError("acp_goal", "s1").code).toBe("turn_authority_unavailable")
})

test("a finalization releases the lease so the session is admissible again", () => {
  const store = session("s2")
  const authority = registerTurnAuthority(store, "acp_goal", { sessionId: "s2", assistantMessageId: "asst-1" })!
  store.startTurn({ sessionId: "s2", agentSessionId: "agent-s2", assistantMessageId: "asst-1", agent: "build", parts: [] })

  finalizeAuthoredTurn(store, authority, { status: "completed", completedAt: Date.now() })

  expect(store.readTurnAuthority("s2")).toBeUndefined()
  expect(registerTurnAuthority(store, "acp_goal", { sessionId: "s2", assistantMessageId: "asst-2" })).toBeDefined()
})

test("a finalization the store refuses still releases the lease", () => {
  const store = session("s3")
  const authority = registerTurnAuthority(store, "acp_goal", { sessionId: "s3", assistantMessageId: "asst-1" })!
  store.startTurn({ sessionId: "s3", agentSessionId: "agent-s3", assistantMessageId: "asst-1", agent: "build", parts: [] })

  const refusing = new Proxy(store, {
    get: (target, key, receiver) => key === "finishTurn"
      ? () => { throw new Error("journal is unavailable") }
      : Reflect.get(target, key, receiver),
  })

  expect(() => finalizeAuthoredTurn(refusing, authority, { status: "completed", completedAt: Date.now() }))
    .toThrow("journal is unavailable")
  // Holding a lease this authority can no longer use would block the session
  // for the life of the process.
  expect(store.readTurnAuthority("s3")).toBeUndefined()
  expect(registerTurnAuthority(store, "acp_goal", { sessionId: "s3", assistantMessageId: "asst-2" })).toBeDefined()
})

test("a terminal presenting a lease the session has moved past is refused", () => {
  const store = session("s4")
  const stale = registerTurnAuthority(store, "acp_goal", { sessionId: "s4", assistantMessageId: "asst-1" })!
  store.startTurn({ sessionId: "s4", agentSessionId: "agent-s4", assistantMessageId: "asst-1", agent: "build", parts: [] })
  finalizeAuthoredTurn(store, stale, { status: "completed", completedAt: Date.now() })

  // The session is admitted to a replacement turn, and the old projection's
  // terminal arrives late.
  const replacement = registerTurnAuthority(store, "acp_goal", { sessionId: "s4", assistantMessageId: "asst-2" })!
  store.startTurn({ sessionId: "s4", agentSessionId: "agent-s4", assistantMessageId: "asst-2", agent: "build", parts: [] })

  expect(() => finalizeAuthoredTurn(store, stale, { status: "completed", completedAt: Date.now() }))
    .toThrow()
  // The replacement is untouched: its lease is still the session's.
  expect(store.readTurnAuthority("s4")?.leaseId).toBe(replacement.leaseId)
})

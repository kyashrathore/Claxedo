import { expect, test } from "bun:test"
import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import { sessionStatus, type CompatEnvelope } from "@claxedo/agent-sdk-runtime/compat-events"
import { createRuntimeEventHub } from "./runtime-event-hub"

const status = (sessionID: string, type: "busy" | "idle" = "busy"): CompatEnvelope => ({ directory: "/repo", payload: sessionStatus(sessionID, { type }) })
const usage = (sessionID: string, messageID: string) => ({ directory: "/repo", payload: { type: "session.usage", properties: { sessionID, messageID } } }) as unknown as CompatEnvelope
const titled = (id: string): CompatEnvelope => ({ directory: "/repo", payload: { type: "session.updated", properties: { sessionID: id, info: { id, title: "Named" } } } }) as unknown as CompatEnvelope

function observed() {
  const hub = createRuntimeEventHub()
  const seen: string[] = []
  hub.subscribeGlobal(({ payload }) => {
    const properties = payload.properties as { sessionID?: string; messageID?: string }
    seen.push(`${payload.type}:${properties.sessionID}${properties.messageID ? `:${properties.messageID}` : ""}`)
  })
  hub.subscribeRuntime((envelope) => { seen.push(`runtime:${envelope.sessionId}:${envelope.assistantMessageId ?? ""}`) })
  return { hub, seen }
}

test("a slot holds the session's turnless frames behind its own and releases them in order", () => {
  const { hub, seen } = observed()
  const slot = hub.openSlot("s1", "msg_asking")
  hub.publishGlobal(status("s1", "idle"))
  hub.publishRuntime({ directory: "/repo", sessionId: "s1", payload: { type: "text-delta", delta: "x" } as AgentRuntimeEvent })
  let bus = false
  hub.sequence("s1", () => { bus = true })
  expect(seen).toEqual([])
  expect(bus).toBe(false)
  slot.publishGlobal(titled("s1"))
  expect(seen).toEqual(["session.updated:s1"])
  slot.close()
  expect(seen).toEqual(["session.updated:s1", "session.status:s1", "runtime:s1:"])
  expect(bus).toBe(true)
})

test("a later turn's first frame releases the slot at once, after what already waited, and is never held", () => {
  for (const next of ["busy", "message", "runtime"] as const) {
    const { hub, seen } = observed()
    const slot = hub.openSlot("s1", "msg_asking")
    hub.publishGlobal(status("s1", "idle"))
    if (next === "busy") hub.publishGlobal(status("s1"))
    if (next === "message") hub.publishGlobal(usage("s1", "msg_next"))
    if (next === "runtime") hub.publishRuntime({ directory: "/repo", sessionId: "s1", assistantMessageId: "msg_next", payload: { type: "text-delta", delta: "x" } as AgentRuntimeEvent })
    expect(seen).toEqual(["session.status:s1", next === "busy" ? "session.status:s1" : next === "message" ? "session.usage:s1:msg_next" : "runtime:s1:msg_next"])
    hub.publishGlobal(status("s1", "idle"))
    expect(seen).toHaveLength(3)
    slot.publishGlobal(titled("s1"))
    expect(seen.at(-1)).toBe("session.updated:s1")
    slot.close()
  }
})

test("the frames of the turn that opened the slot, and other sessions' frames, are not held", () => {
  const { hub, seen } = observed()
  const slot = hub.openSlot("s1", "msg_asking")
  hub.publishGlobal(usage("s1", "msg_asking"))
  hub.publishRuntime({ directory: "/repo", sessionId: "s1", assistantMessageId: "msg_asking", payload: { type: "text-delta", delta: "x" } as AgentRuntimeEvent })
  hub.publishGlobal(status("s2"))
  expect(seen).toEqual(["session.usage:s1:msg_asking", "runtime:s1:msg_asking", "session.status:s2"])
  slot.close()
  slot.close()
  hub.publishGlobal(status("s1"))
  expect(seen.at(-1)).toBe("session.status:s1")
})

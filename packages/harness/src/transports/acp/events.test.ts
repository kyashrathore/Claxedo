import { expect, test } from "bun:test"
import { AsyncPushQueue } from "@claxedo/helpers"
import type { RoutedEvent } from "../../contract"
import type { AcpEntry } from "./index"
import { acpObserveSubagent, acpReceiver, acpUpdate } from "./events"

for (const owner of ["prompt", "provider"] as const) {
  test(`child output enters the active ${owner} receiver with its correlation key`, async () => {
    const queue = new AsyncPushQueue<RoutedEvent>()
    const session = { binding: { upstreamSessionId: "parent" } } as AcpEntry["session"]
    const receive = acpReceiver("acp", session, queue)
    const entry = { session, sideSessions: new Map(), ...(owner === "prompt" ? { receive } : { providerTurn: { receive } }) } as AcpEntry
    await acpUpdate(entry, { sessionId: "child", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "child evidence" } } }, async () => {})
    queue.end()
    const events = await Array.fromAsync(queue)
    expect(events).toContainEqual(expect.objectContaining({ event: expect.objectContaining({ type: "text-delta", delta: "child evidence" }), route: { kind: "child", correlationKey: "child" } }))
  })
}

test("a subagent's end reaches the broker only after the turn took the child output streamed before it", async () => {
  const queue = new AsyncPushQueue<RoutedEvent>()
  const session = { binding: { upstreamSessionId: "parent" } } as AcpEntry["session"]
  const observed: string[] = []
  const entry = { session, sideSessions: new Map(), queue, receive: acpReceiver("acp", session, queue),
    peer: { handshake: { protocolVersion: 1, _meta: { jetbrains: { air: { version: 1, capabilities: ["nativeSubagentSessions"] } } } } },
    turnBroker: { observeSubagent: async (observation: { status: string }) => { observed.push(observation.status); return undefined }, associateChild() {} },
  } as unknown as AcpEntry
  const observe = (update: unknown) => acpObserveSubagent(entry, update)
  await observe({ sessionUpdate: "subagent_spawned", subagentSessionId: "child", name: "researcher", task: "find it" })
  await acpUpdate(entry, { sessionId: "child", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "child evidence" } } }, observe)
  const ended = observe({ sessionUpdate: "subagent_state_update", subagentSessionId: "child", state: "completed" })
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(observed).toEqual(["running"])
  expect((await queue.next()).value).toMatchObject({ event: { type: "text-delta", delta: "child evidence" }, route: { kind: "child", correlationKey: "child" } })
  void queue.next()
  await ended
  expect(observed).toEqual(["running", "completed"])
})

import { expect, test } from "bun:test"
import type { RoutedEvent, SessionBroker } from "../../contract"
import type { AcpEntry } from "./index"
import { AcpChildren } from "./children"
import { acpObserveSubagent, acpUpdate } from "./events"

function fixture() {
  const events: RoutedEvent[] = []
  const observed: string[] = []
  const broker = { publishChild: async (event: RoutedEvent) => { events.push(event) },
    observeSubagent: async (observation: { status: string }) => { observed.push(observation.status); return undefined }, associateChild() {} } as unknown as SessionBroker
  const entry = { session: { binding: { upstreamSessionId: "parent" } }, sideSessions: new Map(), broker,
    children: new AcpChildren("acp", broker),
    peer: { handshake: { protocolVersion: 1, _meta: { jetbrains: { air: { version: 1, capabilities: ["nativeSubagentSessions"] } } } } },
  } as unknown as AcpEntry
  return { entry, broker, events, observed }
}

for (const owner of ["prompt", "provider", "idle"] as const) test(`child output uses the session route while the parent is ${owner}`, async () => {
  const f = fixture()
  const receive = () => { throw new Error("Child output entered the parent's translator") }
  if (owner === "prompt") f.entry.receive = receive
  if (owner === "provider") f.entry.providerTurn = { receive } as unknown as AcpEntry["providerTurn"]
  await acpObserveSubagent(f.entry, { sessionUpdate: "subagent_spawned", subagentSessionId: "child", name: "reviewer", task: "review" })
  await acpUpdate(f.entry, { sessionId: "child", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "child evidence" } } })
  expect(f.events).toContainEqual(expect.objectContaining({ event: expect.objectContaining({ type: "text-delta", delta: "child evidence" }), route: { kind: "child", correlationKey: "child" } }))
})

test("foreign ACP sessions are not inferred to be native children", async () => {
  const f = fixture()
  await acpUpdate(f.entry, { sessionId: "title-session", update: { sessionUpdate: "available_commands_update", availableCommands: [] } })
  await acpUpdate(f.entry, { sessionId: "title-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "title" } } })
  expect(f.events).toEqual([])
  expect(f.entry.children.hasLive).toBe(false)
})

test("a replayed ACP spawn after completion cannot block future configuration", async () => {
  const f = fixture()
  const spawn = { sessionUpdate: "subagent_spawned", subagentSessionId: "child", name: "researcher", task: "find it" }
  await acpObserveSubagent(f.entry, spawn)
  expect(f.entry.children.hasLive).toBe(true)
  await acpObserveSubagent(f.entry, { sessionUpdate: "subagent_state_update", subagentSessionId: "child", state: "completed" })
  expect(f.entry.children.hasLive).toBe(false)
  await acpObserveSubagent(f.entry, spawn)
  expect(f.entry.children.hasLive).toBe(false)
})

for (const state of ["completed", "failed", "cancelled", "disconnected"]) test(`ACP ${state} ends its session-owned child`, async () => {
  const f = fixture()
  await acpObserveSubagent(f.entry, { sessionUpdate: "subagent_spawned", subagentSessionId: "child", name: "researcher", task: "find it" })
  await acpUpdate(f.entry, { sessionId: "child", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "child evidence" } } })
  await acpObserveSubagent(f.entry, { sessionUpdate: "subagent_state_update", subagentSessionId: "child", state })
  expect(f.events.some(({ event }) => event.type === "text-delta")).toBe(true)
  expect(f.observed).toEqual(["running", { completed: "completed", failed: "failed", cancelled: "killed", disconnected: "interrupted" }[state]!])
  expect(f.entry.children.hasLive).toBe(false)
})

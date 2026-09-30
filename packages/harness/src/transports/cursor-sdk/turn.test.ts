import { expect, test } from "bun:test"
import type { SDKMessage } from "@cursor/sdk"
import type { RoutedEvent, TurnBroker } from "../../contract"
import type { CursorHost } from "./host-registry"
import type { HostReply, HostResult, HostSession } from "./protocol"
import { streamCursorRun } from "./turn"

const session: HostSession = { sessionId: "s1", directory: "/tmp", apiKey: "test", mcpServers: {}, local: {} }
const ids = { agent_id: "agent-1", run_id: "run-1" }

function hostReplying(messages: SDKMessage[], result: HostResult): CursorHost {
  return { call: async (_command: unknown, onEvent?: (reply: HostReply) => void) => {
    for (const message of messages) onEvent?.({ id: 1, kind: "event", message })
    return { id: 1, kind: "result", value: result }
  } } as unknown as CursorHost
}

async function drain(host: CursorHost): Promise<RoutedEvent[]> {
  const broker = { signal: new AbortController().signal, observeSubagent: async () => undefined, associateChild() {} } as unknown as TurnBroker
  const events: RoutedEvent[] = []
  for await (const event of streamCursorRun({ host, session, prompt: "hello", broker })) events.push(event)
  return events
}

test("a run Cursor reports as failed ends the turn with the SDK's reason as its one error, and the stream does not throw", async () => {
  const events = await drain(hostReplying([
    { type: "status", ...ids, status: "RUNNING" },
    { type: "assistant", ...ids, message: { role: "assistant", content: [{ type: "text", text: "partial" }] } },
    { type: "status", ...ids, status: "ERROR", message: "[unavailable] HTTP 429" },
  ], { agentId: "agent-1", runId: "run-1", status: "error", error: { message: "[unavailable] HTTP 429" } }))
  expect(events.filter((item) => item.event.type === "error").map((item) => item.event)).toMatchObject([{ type: "error", error: "[unavailable] HTTP 429" }])
  expect(events.filter((item) => ["finish", "cancelled", "error"].includes(item.event.type))).toHaveLength(1)
  expect(events.some((item) => item.event.type === "diagnostic")).toBe(false)
})

test("a finished run has one terminal, from the run's result", async () => {
  const events = await drain(hostReplying([
    { type: "status", ...ids, status: "RUNNING" },
    { type: "status", ...ids, status: "FINISHED" },
  ], { agentId: "agent-1", runId: "run-1", status: "finished" }))
  expect(events.filter((item) => ["finish", "cancelled", "error"].includes(item.event.type)).map((item) => item.event))
    .toEqual([{ type: "finish", sessionId: "run-1", harness: "cursor", threadId: "s1" }])
})

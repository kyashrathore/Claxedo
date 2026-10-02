import { expect, test } from "bun:test"
import { ClientSideConnection, type AnyMessage } from "@agentclientprotocol/sdk"
import { AcpRequestScope } from "./request-scope"
import { acpOrderedUpdates } from "./wire-updates"

function agentLines(messages: AnyMessage[]) {
  return new ReadableStream<AnyMessage>({
    start(controller) {
      for (const message of messages) controller.enqueue(message)
    },
  })
}

function update(sessionId: string, value: Record<string, unknown>): AnyMessage {
  return { jsonrpc: "2.0", method: "session/update", params: { sessionId, update: value } }
}

test("updates reach their handlers in the order the agent wrote them, whichever path each takes", async () => {
  const delivered: string[] = []
  const all = Promise.withResolvers<void>()
  const record = (entry: string) => { delivered.push(entry); if (delivered.length === 4) all.resolve() }
  const wired = acpOrderedUpdates({
    readable: agentLines([
      update("child", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "child evidence" } }),
      update("parent", { sessionUpdate: "subagent_state_update", subagentSessionId: "child", state: "completed" }),
      update("parent", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "parent reply" } }),
      update("parent", { sessionUpdate: "vendor_progress", percent: 50 }),
    ]),
    writable: new WritableStream<AnyMessage>(),
  }, {
    update: (notification) => record(`update ${notification.sessionId} ${notification.update.sessionUpdate}`),
    extension: (sessionId, value) => record(`extension ${sessionId} ${(value as { sessionUpdate: string }).sessionUpdate}`),
    unknown: (sessionId, method, value) => record(`unknown ${sessionId} ${method} ${(value as { sessionUpdate: string }).sessionUpdate}`),
  }, new AcpRequestScope())
  const connection = new ClientSideConnection(() => ({
    requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    sessionUpdate: wired.sessionUpdate,
  }), wired.stream)
  await all.promise
  expect(delivered).toEqual([
    "update child agent_message_chunk",
    "extension parent subagent_state_update",
    "update parent agent_message_chunk",
    "unknown parent session/update vendor_progress",
  ])
  await wired.cancel()
  void connection
})

test("a notice takes the translator's path, and compaction, which Claxedo does not advertise, is an unknown update", async () => {
  const delivered: string[] = []
  const all = Promise.withResolvers<void>()
  const record = (entry: string) => { delivered.push(entry); if (delivered.length === 3) all.resolve() }
  const wired = acpOrderedUpdates({
    readable: agentLines([
      update("parent", { sessionUpdate: "notice", severity: "info", title: "Indexed the workspace" }),
      update("parent", { sessionUpdate: "compaction_update", compactionId: "c1", status: "in_progress" }),
      update("parent", { sessionUpdate: "compaction_summary_chunk", compactionId: "c1", content: { type: "text", text: "Summary" } }),
    ]),
    writable: new WritableStream<AnyMessage>(),
  }, {
    update: (notification) => record(`update ${notification.update.sessionUpdate}`),
    extension: (_sessionId, value) => record(`extension ${(value as { sessionUpdate: string }).sessionUpdate}`),
    unknown: (_sessionId, _method, value) => record(`unknown ${(value as { sessionUpdate: string }).sessionUpdate}`),
  }, new AcpRequestScope())
  const connection = new ClientSideConnection(() => ({
    requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    sessionUpdate: wired.sessionUpdate,
  }), wired.stream)
  await all.promise
  expect(delivered).toEqual(["update notice", "unknown compaction_update", "unknown compaction_summary_chunk"])
  await wired.cancel()
  void connection
})

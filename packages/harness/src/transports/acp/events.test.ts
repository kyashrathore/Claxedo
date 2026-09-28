import { expect, test } from "bun:test"
import { AsyncPushQueue } from "@claxedo/helpers"
import type { RoutedEvent } from "../../contract"
import type { AcpEntry } from "./index"
import { acpReceiver, acpUpdate } from "./events"

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

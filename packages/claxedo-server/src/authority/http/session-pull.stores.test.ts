import { afterEach, expect, test, vi } from "vitest"
import { selfHostedSessionStores } from "../../test-support/self-hosted-session-stores"
import { projectionSessionReads } from "../../session/projection-session-reads"
import { pullControlSessionMessages } from "./session-pull"

let stores: Awaited<ReturnType<typeof selfHostedSessionStores>> | undefined
afterEach(() => {
  stores?.dispose()
  stores = undefined
})

test("a checkpoint whose authority write failed after the projection committed is repaired by the next pull", async () => {
  stores = await selfHostedSessionStores()
  const { services, authority, auth, workspaceId, sessionId, runtime, options, assistantMessage, messageId } = stores
  const checkpoint = () => pullControlSessionMessages(services, options, auth, { workspaceId, sessionId })
  const read = async () => await projectionSessionReads(services).messages(auth, { sessionId, workspaceId }) as {
    messages: Array<{ info: { id: string } }>
    maxEventOrdinal: number
  }

  runtime.snapshot = { messages: [assistantMessage("a1")], maxEventOrdinal: 1 }
  await checkpoint()

  runtime.snapshot = { messages: [assistantMessage("a1"), assistantMessage("a2")], maxEventOrdinal: 2 }
  vi.spyOn(authority, "syncSessionMessages").mockRejectedValueOnce(new Error("authority unavailable"))
  await expect(checkpoint()).rejects.toThrow("authority unavailable")
  expect(services.projectionStore.read_session_max_event_ordinal(sessionId)).toBe(2)

  await checkpoint()
  const converged = await read()
  expect(converged.messages.map((message) => message.info.id)).toEqual([messageId("a1"), messageId("a2")])
  expect(converged.maxEventOrdinal).toBe(2)
})

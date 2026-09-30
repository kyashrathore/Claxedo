import { afterEach, expect, test } from "vitest"
import { selfHostedSessionStores } from "../test-support/self-hosted-session-stores"
import { projectionSessionReads } from "./projection-session-reads"

let stores: Awaited<ReturnType<typeof selfHostedSessionStores>> | undefined
afterEach(() => {
  stores?.dispose()
  stores = undefined
})

type Body = { messages: Array<{ info: { id: string } }>; maxEventOrdinal: number }

async function divergedStores(input: { authority: number; projection: number }) {
  stores = await selfHostedSessionStores()
  const { services, authority, auth, workspaceId, sessionId, projectionWorkspace: ws, assistantMessage, messageId } = stores
  const transcript = (ordinal: number) => Array.from({ length: ordinal }, (_, index) => assistantMessage(`a${index + 1}`))
  await authority.syncSessionMessages(auth, {
    sessionId,
    workspaceId,
    updatedAt: 2,
    messages: transcript(input.authority),
    maxEventOrdinal: input.authority,
  })
  await services.projectionStore.sync_session_meta(ws, { id: sessionId, time: { created: 1, updated: 2 } })
  await services.projectionStore.sync_session_messages(ws, sessionId, transcript(input.projection), { maxEventOrdinal: input.projection })
  const reads = projectionSessionReads(services)
  return {
    ids: (...names: string[]) => names.map(messageId),
    signed: async (page?: { limit: number }) =>
      await reads.messages(auth, { sessionId, workspaceId, ...(page ? { page } : {}) }) as Body,
    loopback: async () => await reads.messages(undefined, { sessionId }) as Body,
  }
}

const ids = (body: Body) => body.messages.map((message) => message.info.id)

test("a signed read behind the projection answers the authority's transcript at the authority's ordinal", async () => {
  const read = await divergedStores({ authority: 1, projection: 2 })
  for (const body of [await read.signed(), await read.signed({ limit: 10 })]) {
    expect(ids(body)).toEqual(read.ids("a1"))
    expect(body.maxEventOrdinal).toBe(1)
  }
  const loopback = await read.loopback()
  expect(ids(loopback)).toEqual(read.ids("a1", "a2"))
  expect(loopback.maxEventOrdinal).toBe(2)
})

test("a signed read ahead of the projection keeps the authority's ordinal", async () => {
  const read = await divergedStores({ authority: 2, projection: 1 })
  for (const body of [await read.signed(), await read.signed({ limit: 10 })]) {
    expect(ids(body)).toEqual(read.ids("a1", "a2"))
    expect(body.maxEventOrdinal).toBe(2)
  }
  const loopback = await read.loopback()
  expect(ids(loopback)).toEqual(read.ids("a1"))
  expect(loopback.maxEventOrdinal).toBe(1)
})

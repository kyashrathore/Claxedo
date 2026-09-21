import { expect, test } from "bun:test"
import { createEventPump } from "./event-pump"
import type { OpenCodeClient, OpenCodeHost } from "./host"

function host(client: () => Promise<OpenCodeClient>): OpenCodeHost {
  return { client, status: () => ({ lifecycle: "ready", events: "healthy" }), setEventHealth() {}, async close() {} }
}

test("a stop taken while the client is still booting opens no subscription", async () => {
  const boot = Promise.withResolvers<OpenCodeClient>()
  let subscriptions = 0
  const client = {
    events: {
      subscribe() {
        subscriptions++
        return { async *[Symbol.asyncIterator]() {} }
      },
    },
  } as unknown as OpenCodeClient
  const pump = createEventPump(host(() => boot.promise), { onEvent() {} })
  pump.start()
  // The refusal lands before the boot answers, which is the whole window a
  // guard can cover: a stop scheduled after the resolution is a stop the
  // subscription already precedes.
  const stopped = pump.stop()
  boot.resolve(client)
  await stopped
  expect(subscriptions).toBe(0)
})

test("the drain ends with the outstanding read, which is observed but never dispatched", async () => {
  const pending = Promise.withResolvers<IteratorResult<unknown>>()
  let returned = 0
  const iterator = { next: () => pending.promise, async return() { returned++; return { done: true as const, value: undefined } } }
  const client = { events: { subscribe: () => ({ [Symbol.asyncIterator]: () => iterator }) } } as unknown as OpenCodeClient
  const delivered: unknown[] = []
  const pump = createEventPump(host(async () => client), { onEvent: event => delivered.push(event) })
  pump.start()
  await pump.ready()

  let finished = false
  const drained = pump.stop().then(() => { finished = true })
  for (let index = 0; index < 12; index++) await Promise.resolve()
  expect(finished).toBe(false)

  // What closing the host does to a read the engine still owes.
  pending.resolve({ done: false, value: { id: "late", type: "session.updated" } })
  await drained

  expect(returned).toBe(1)
  expect(delivered).toEqual([])
})

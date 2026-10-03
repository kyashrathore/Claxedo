/// <reference types="bun" />
import { expect, test } from "bun:test"
import { createAttentionReceipts } from "./attention-receipts"
import { placementId, projectId, sessionId } from "./ids"
import type { ServerEvent } from "./events"

function raised(sequence: number, generation = 1): Extract<ServerEvent, { type: "attentionRaised" }> {
  return { type: "attentionRaised", ref: { projectId: projectId("p1"), placementId: placementId("w1"), sessionId: sessionId("s1") }, generation, delivery: "live", event: { sequence, kind: "outcome", outcome: "completed", openedAt: sequence } }
}

test("the event owner delivers one canonical attention identity across account and local streams", () => {
  const accept = createAttentionReceipts()
  expect(accept(raised(10))).toBe(true)
  expect(accept(raised(10))).toBe(false)
  expect(accept(raised(11))).toBe(true)
  expect(accept(raised(9))).toBe(true)
})

test("replayed history records its positions before delayed live duplicates arrive", () => {
  const accept = createAttentionReceipts()
  expect(accept({ ...raised(20), delivery: "replay" })).toBe(true)
  expect(accept(raised(20))).toBe(false)
  expect(accept(raised(21))).toBe(true)
})

test("positions include their generation and retain distinct recovered events from previous generations", () => {
  const accept = createAttentionReceipts()
  expect(accept(raised(40))).toBe(true)
  expect(accept(raised(50, 50))).toBe(true)
  expect(accept({ ...raised(41), delivery: "replay" })).toBe(true)
})

test("identities distinguish identical session ids in different placements", () => {
  const accept = createAttentionReceipts()
  const event = raised(10)
  expect(accept(event)).toBe(true)
  expect(accept({ ...event, ref: { ...event.ref, placementId: placementId("w2") } })).toBe(true)
})

test("a later live completion cannot hide an earlier question recovered from durable history", () => {
  const accept = createAttentionReceipts()
  const live = raised(20)
  const recovered = { ...raised(10), delivery: "replay" as const, event: { sequence: 10, kind: "question" as const, requestId: "q1", openedAt: 10 } }
  expect(accept(live)).toBe(true)
  expect(accept(recovered)).toBe(true)
  expect(accept(recovered)).toBe(false)
})

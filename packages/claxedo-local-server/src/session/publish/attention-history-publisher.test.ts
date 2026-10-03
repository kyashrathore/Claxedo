import { describe, expect, test } from "vitest"
import type { SessionAttentionPage } from "@claxedo/agent-runtime-contract"
import type { HostSessionRow } from "@claxedo/server-core/platform/auth/host-session-rows"
import { createAttentionHistoryPublisher } from "./attention-history-publisher"

function row(sequence = 8, generation = 1): HostSessionRow {
  return { workspaceId: "ws", sessionId: "ses", createdAt: 1, updatedAt: 8,
    status: { kind: "idle", awaitingInput: false, at: 8 },
    attention: { sequence, generation, activitySequence: generation, activityAt: 1, working: false, awaitingInput: false } }
}

describe("canonical attention history publication", () => {
  test("drains every page through the captured row, preserving questions resolved inside batching", async () => {
    const asked = { sequence: 2, kind: "question" as const, requestId: "question", openedAt: 2 }
    const finished = { sequence: 8, kind: "outcome" as const, outcome: "completed" as const, openedAt: 8 }
    const calls: number[] = []
    const publisher = createAttentionHistoryPublisher({ attentionPage: async (_, __, after) => {
      calls.push(after)
      return after === 0 ? { generation: 1, through: 10, events: [asked], next: 2 }
        : { generation: 1, through: 10, events: [finished, { sequence: 10, kind: "permission", requestId: "later", openedAt: 10 }] }
    } })
    const batches = await publisher.read(row())
    expect(calls).toEqual([0, 2])
    expect(batches.map((batch) => batch.through)).toEqual([2, 8])
    expect(batches.flatMap((batch) => batch.events)).toEqual([asked, finished])
    expect(await publisher.read(row())).toEqual(batches)
    for (const batch of batches) publisher.acknowledge(batch)
    expect(await publisher.read(row())).toEqual([])
  })

  test("new generation restarts from canonical history and a rejected acknowledgement does not advance", async () => {
    const calls: number[] = []
    let generation = 1
    const publisher = createAttentionHistoryPublisher({ attentionPage: async (_, __, after) => {
      calls.push(after)
      return { generation, through: 8, events: [] }
    } })
    publisher.acknowledge((await publisher.read(row()))[0])
    generation = 6
    const batches = await publisher.read(row(8, generation))
    expect(await publisher.read(row(8, generation))).toEqual(batches)
    publisher.acknowledge(batches[0])
    expect(await publisher.read(row(8, generation))).toEqual([])
    expect(calls).toEqual([0, 0, 0])
  })

  test("generation changes and stalled pages fail without consuming a cursor", async () => {
    let page: SessionAttentionPage = { generation: 2, through: 8, events: [] }
    const calls: number[] = []
    const publisher = createAttentionHistoryPublisher({ attentionPage: async (_, __, after) => { calls.push(after); return page } })
    await expect(publisher.read(row())).rejects.toThrow("generation changed")
    page = { generation: 1, through: 8, next: 0, events: [] }
    await expect(publisher.read(row())).rejects.toThrow("no progress")
    page = { generation: 1, through: 8, events: [] }
    await publisher.read(row())
    expect(calls).toEqual([0, 0, 0])
  })
})

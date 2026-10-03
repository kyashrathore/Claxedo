import { describe, expect, test } from "bun:test"
import { sessionAttention, updateSessionReader, type SessionAttentionFacts, type SessionReaderState } from "./session-attention"

const facts: SessionAttentionFacts = {
  sequence: 12,
  generation: 1,
  activitySequence: 12,
  activityAt: 200,
  outcome: { sequence: 12, status: "completed", completedAt: 200 },
  working: false,
  awaitingInput: false,
}


const empty: SessionReaderState = { generation: 1, revision: 0, seenThrough: 0 }


describe("session attention and reader commands", () => {
  test("idle results need attention after reading, until the reader explicitly settles", () => {
    expect(sessionAttention(facts, empty)).toEqual({ unseen: true, settled: false })
    const read = updateSessionReader(facts, empty, { kind: "seen", generation: 1, outcomeSequence: 12 }, 300)
    expect(read).toMatchObject({ ok: true, state: { seenThrough: 12, seenAt: 300 } })
    if (!read.ok) throw new Error("read refused")
    expect(sessionAttention(facts, read.state)).toEqual({ unseen: false, settled: false })
  })

  test("a delayed read of the prior outcome leaves the next result unread", () => {
    const read = updateSessionReader(facts, empty, { kind: "seen", generation: 1, outcomeSequence: 8 }, 300)
    if (!read.ok) throw new Error("read refused")
    expect(sessionAttention(facts, read.state).unseen).toBe(true)
    expect(updateSessionReader(facts, read.state, { kind: "seen", generation: 1, outcomeSequence: 3 }, 400)).toEqual({ ok: true, state: read.state })
  })

  test("settle acknowledges the selected result and later activity wakes permanently", () => {
    const settled = updateSessionReader(facts, empty, { kind: "settle", generation: 1, activitySequence: 12, outcomeSequence: 12, revision: 0 }, 300)
    if (!settled.ok) throw new Error("settle refused")
    expect(sessionAttention(facts, settled.state)).toEqual({ unseen: false, settled: true })
    expect(sessionAttention({ ...facts, activitySequence: 13, working: true }, settled.state)).toMatchObject({ settled: false })
    expect(sessionAttention({ ...facts, activitySequence: 13 }, settled.state).settled).toBe(false)
  })

  test("waiting wins over work, work wins over old unread results, and busy settle conflicts", () => {
    expect(updateSessionReader({ ...facts, working: true }, empty, { kind: "settle", generation: 1, activitySequence: 12, outcomeSequence: 12, revision: 0 }, 300)).toEqual({ ok: false, reason: "working" })
  })

  test("stale settlement, future acknowledgement, and old-generation commands are refused", () => {
    expect(updateSessionReader(facts, empty, { kind: "settle", generation: 1, activitySequence: 11, outcomeSequence: 8, revision: 0 }, 300)).toEqual({ ok: false, reason: "activity_changed" })
    expect(updateSessionReader(facts, empty, { kind: "seen", generation: 1, outcomeSequence: 13 }, 300)).toEqual({ ok: false, reason: "invalid_outcome" })
    expect(updateSessionReader(facts, empty, { kind: "seen", generation: 0, outcomeSequence: 12 }, 300)).toEqual({ ok: false, reason: "generation_changed" })
  })

  test("return requires the current reader revision and does not manufacture unseen work", () => {
    const state = { ...empty, revision: 2, seenThrough: 12, settledThrough: 12, settledAt: 250 }
    expect(updateSessionReader(facts, state, { kind: "return", generation: 1, revision: 1 }, 300)).toEqual({ ok: false, reason: "reader_changed" })
    const returned = updateSessionReader(facts, state, { kind: "return", generation: 1, revision: 2 }, 300)
    if (!returned.ok) throw new Error("return refused")
    expect(returned.state.settledAt).toBeUndefined()
    expect(sessionAttention(facts, returned.state)).toEqual({ unseen: false, settled: false })
  })

  test("cancelled outcomes and sessions with no outcome have no unread result", () => {
    expect(sessionAttention({ ...facts, outcome: undefined }, empty)).toEqual({ unseen: false, settled: false })
    expect(sessionAttention({ ...facts, outcome: { ...facts.outcome!, status: "cancelled" } }, empty)).toEqual({ unseen: false, settled: false })
  })

  test("failed results stay Needs after Seen and a different reader's settlement has no effect", () => {
    const failed = { ...facts, outcome: { ...facts.outcome!, status: "failed" as const } }
    const seen = { ...empty, seenThrough: 12, revision: 1 }
    expect(sessionAttention(failed, seen)).toEqual({ unseen: false, settled: false })
    expect(sessionAttention(failed, { ...seen, settledThrough: 12 }).settled).toBe(true)
    expect(sessionAttention(failed, empty).settled).toBe(false)
    expect(sessionAttention(failed, { ...seen, generation: 0, settledThrough: 12 }).settled).toBe(false)
  })
})

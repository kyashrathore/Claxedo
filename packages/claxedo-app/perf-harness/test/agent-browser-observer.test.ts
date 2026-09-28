import { describe, expect, test } from "bun:test"
import {
  PAINT_SETTLE_CONFIRMATION_FRAMES,
  completeFirstFold,
  paintSettle,
  latestTurnIdentity,
  settleFrameLog,
  seededSwitchSequence,
  semanticTimelinePaintReady,
  warmSwitchPlan,
  type PaintSettleFrame,
} from "../src/agent-browser-observer"

const FRAME_MS = 1000 / 60

const ALL_GATES = {
  displayedDestination: true,
  latestTurnPainted: true,
  noPlaceholder: true,
  firstFoldComplete: true,
  composerEditable: true,
  windowVisibleFocused: true,
}

function frame(index: number, signature: string | undefined, mutated = false): PaintSettleFrame {
  return {
    observedAtMs: 100 + index * FRAME_MS,
    gates: signature === undefined ? { ...ALL_GATES, latestTurnPainted: false } : ALL_GATES,
    ready: signature !== undefined,
    signature: signature === undefined ? undefined : { rows: signature },
    mutated,
  }
}

function frames(spec: string): PaintSettleFrame[] {
  return [...spec].map((code, index) => {
    if (code === ".") return frame(index, undefined)
    if (code === "!") return frame(index, "a", true)
    return frame(index, code)
  })
}

describe("paint settle", () => {
  const confirm = 3

  test("confirms thirty unchanged frames, 250 ms at 120 Hz", () => {
    expect(PAINT_SETTLE_CONFIRMATION_FRAMES).toBe(30)
    expect(PAINT_SETTLE_CONFIRMATION_FRAMES * (FRAME_MS / 2)).toBeGreaterThanOrEqual(250)
  })

  test("reports the first frame of the final run, not the confirming frame", () => {
    const settled = paintSettle(frames("..aaaa"), confirm)
    expect(settled).toEqual({ settledAtMs: frame(2, "a").observedAtMs, runStartIndex: 2 })
  })

  test("does not settle while the run is shorter than the confirmation window", () => {
    expect(paintSettle(frames("..aaa"), confirm)).toBeUndefined()
    expect(paintSettle(frames(""), confirm)).toBeUndefined()
    expect(paintSettle(frames("......"), confirm)).toBeUndefined()
  })

  test("a tail-only first view followed by a prepend settles at the prepended view", () => {
    const settled = paintSettle(frames(".aabbbb"), confirm)
    expect(settled).toEqual({ settledAtMs: frame(3, "b").observedAtMs, runStartIndex: 3 })
  })

  test("a placeholder flash back to the same content restarts the run", () => {
    const settled = paintSettle(frames("aaa.aaaa"), confirm)
    expect(settled).toEqual({ settledAtMs: frame(4, "a").observedAtMs, runStartIndex: 4 })
  })

  test("a mutation-only frame with an unchanged signature restarts the run", () => {
    const sequence = frames("aaa!aaaa")
    expect(sequence[3]).toMatchObject({ ready: true, mutated: true, signature: { rows: "a" } })
    expect(paintSettle(sequence, confirm)).toEqual({ settledAtMs: frame(3, "a").observedAtMs, runStartIndex: 3 })
    expect(paintSettle(frames("aaa!aa"), confirm)).toBeUndefined()
  })

  test("signature comparison is by value across the JSON boundary", () => {
    const sequence = frames("aaaa").map((entry) => ({ ...entry, signature: { rows: [["k1", 12, 0.5]], scrollTop: 10 } }))
    expect(paintSettle(sequence, confirm)?.runStartIndex).toBe(0)
    const shifted = sequence.map((entry, index) => (index === 2 ? { ...entry, signature: { ...entry.signature, scrollTop: 11 } } : entry))
    expect(paintSettle(shifted, confirm)).toBeUndefined()
  })

  test("the earliest complete run wins even when a later change follows", () => {
    const settled = paintSettle(frames("aaaab"), confirm)
    expect(settled?.runStartIndex).toBe(0)
  })
})

describe("frame log", () => {
  test("carries every frame after the start with its gates, signature and mutation", () => {
    const log = settleFrameLog(frame(1, undefined).observedAtMs, frames(".!.a"), 7)
    expect(log.startAt).toBe(frame(1, undefined).observedAtMs)
    expect(log.offsetMs).toBe(7)
    expect(log.frames).toEqual([
      { at: frame(2, undefined).observedAtMs, gates: { ...ALL_GATES, latestTurnPainted: false }, signature: null, mutated: false },
      { at: frame(3, "a").observedAtMs, gates: ALL_GATES, signature: JSON.stringify({ rows: "a" }), mutated: false },
    ])
  })
})

describe("agent browser scenario ordering", () => {
  test("rejects an overflowing first fold whose mounted rows leave a blank gap", () => {
    expect(
      completeFirstFold({ overflowPx: 2_000, topGapPx: 280, visibleRowCount: 8, virtualKeyCount: 8, rowCount: 120 }),
    ).toBe(false)
    expect(
      completeFirstFold({ overflowPx: 2_000, topGapPx: 48, visibleRowCount: 12, virtualKeyCount: 12, rowCount: 120 }),
    ).toBe(true)
    expect(
      completeFirstFold({ overflowPx: 0, topGapPx: 300, visibleRowCount: 2, virtualKeyCount: 2, rowCount: 2 }),
    ).toBe(true)
  })

  test("accepts only a real canonical latest-turn row in the complete first fold", () => {
    const target = {
      expectedMessageIds: ["msg_latest"],
      expectedPartIds: [],
    }
    const ready = {
      messageId: "msg_latest",
      kind: "AssistantPart" as const,
      partId: undefined,
      textLength: 42,
      composerVisibleAndEnabled: true,
      surfaceFocused: true,
      timelineCoverage: {
        overflowPx: 2_000,
        topGapPx: 24,
        visibleRowCount: 8,
        virtualKeyCount: 8,
        rowCount: 120,
      },
    }

    expect(semanticTimelinePaintReady(ready, target)).toBe(true)
    expect(semanticTimelinePaintReady({ ...ready, messageId: "msg_stale" }, target)).toBe(false)
    expect(semanticTimelinePaintReady({ ...ready, textLength: 0 }, target)).toBe(false)
    expect(semanticTimelinePaintReady({ ...ready, composerVisibleAndEnabled: false }, target)).toBe(false)
    expect(semanticTimelinePaintReady({ ...ready, surfaceFocused: false }, target)).toBe(false)
    expect(
      semanticTimelinePaintReady(
        {
          ...ready,
          timelineCoverage: { ...ready.timelineCoverage, topGapPx: 280 },
        },
        target,
      ),
    ).toBe(false)
  })

  test("identifies the destination's latest turn by message and part, never by rendered text", () => {
    const target = {
      expectedMessageIds: ["msg_latest"],
      expectedPartIds: ["prt_text", "prt_tool"],
    }
    const base = {
      messageId: "msg_latest",
      kind: "AssistantPart" as const,
      textLength: 42,
      composerVisibleAndEnabled: true,
      surfaceFocused: true,
      timelineCoverage: { overflowPx: 2_000, topGapPx: 24, visibleRowCount: 8, virtualKeyCount: 8, rowCount: 120 },
    }
    const textRow = { ...base, partId: "prt_text" }
    expect(latestTurnIdentity(textRow, target)).toBe(true)
    expect(semanticTimelinePaintReady(textRow, target)).toBe(true)
    const toolRow = { ...base, partId: "prt_tool" }
    expect(semanticTimelinePaintReady(toolRow, target)).toBe(true)
    expect(semanticTimelinePaintReady({ ...toolRow, textLength: 0 }, target)).toBe(false)
    expect(latestTurnIdentity({ ...toolRow, partId: "prt_foreign" }, target)).toBe(false)
    expect(semanticTimelinePaintReady({ ...toolRow, partId: "prt_foreign" }, target)).toBe(false)
    const userRow = { ...base, kind: "UserMessage" as const, partId: undefined }
    expect(semanticTimelinePaintReady(userRow, target)).toBe(true)
    expect(semanticTimelinePaintReady({ ...userRow, messageId: "msg_older" }, target)).toBe(false)
  })

  test("randomizes all twenty work items reproducibly without dropping any", () => {
    const first = seededSwitchSequence(
      Array.from({ length: 20 }, (_, index) => `session-${index}`),
      42,
    )
    const second = seededSwitchSequence(
      Array.from({ length: 20 }, (_, index) => `session-${index}`),
      42,
    )
    expect(first).toEqual(second)
    expect(first).toHaveLength(20)
    expect(first.toSorted()).toEqual(Array.from({ length: 20 }, (_, index) => `session-${index}`).toSorted())
    expect(first).not.toEqual(Array.from({ length: 20 }, (_, index) => `session-${index}`))
  })

  test("warms every work item then measures top→bottom rail order", () => {
    const targets = Array.from({ length: 20 }, (_, index) => ({
      sessionId: `session-${index}`,
      title: `Session ${index}`,
      expectedMessageIds: [`message-${index}`],
    }))
    const plan = warmSwitchPlan(targets, 42)

    expect(plan.warmup).toEqual(targets)
    expect(plan.measured).toEqual(targets)
    expect(plan.measured[0]?.sessionId).not.toBe(plan.warmup.at(-1)?.sessionId)
  })
})

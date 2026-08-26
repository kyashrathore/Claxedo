import { describe, expect, test } from "bun:test"
import {
  completeFirstFold,
  paintedContentVerification,
  revealSessionRows,
  seededSwitchSequence,
  semanticTimelinePaintReady,
  warmSwitchPlan,
} from "../src/agent-browser-observer"
import type { BenchmarkPage } from "../src/agent-cdp-page"

function sessionRowRevealPage(
  states: Array<{ missing: number; closedGroups: number; loadMoreCount: number; visibleRows: number }>,
  options: { rejectWait?: boolean } = {},
) {
  let waits = 0
  const page = {
    evaluate: async () => states.shift() ?? { missing: 0, closedGroups: 0, loadMoreCount: 0, visibleRows: 20 },
    waitForFunction: async () => {
      waits++
      if (options.rejectWait) throw new Error("semantic wait timed out")
    },
  } as unknown as BenchmarkPage
  return { page, waits: () => waits }
}

describe("agent browser scenario ordering", () => {
  test("waits for an authoritative sidebar refetch when a target row and next-page control are briefly absent", async () => {
    const harness = sessionRowRevealPage([
      { missing: 1, closedGroups: 0, loadMoreCount: 0, visibleRows: 19 },
      { missing: 0, closedGroups: 0, loadMoreCount: 0, visibleRows: 20 },
    ])

    await revealSessionRows(harness.page, ["session-20"])

    expect(harness.waits()).toBe(1)
  })

  test("fails closed when the authoritative sidebar never exposes the target or another page", async () => {
    const harness = sessionRowRevealPage(
      [{ missing: 1, closedGroups: 0, loadMoreCount: 0, visibleRows: 19 }],
      { rejectWait: true },
    )

    await expect(revealSessionRows(harness.page, ["session-20"])).rejects.toThrow(
      "session sidebar is missing 1 benchmark rows and has no next page",
    )
    expect(harness.waits()).toBe(1)
  })

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
      expectedContentSha256: { msg_latest: "a".repeat(64) },
      expectedTextPartSha256: {},
      expectedPartIds: [],
    }
    const ready = {
      messageId: "msg_latest",
      kind: "AssistantPart" as const,
      partId: undefined,
      textLength: 42,
      contentSha256: "a".repeat(64),
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
    expect(semanticTimelinePaintReady({ ...ready, contentSha256: "b".repeat(64) }, target)).toBe(false)
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

  test("verifies content part-granularly for multi-row assistant messages", () => {
    const target = {
      expectedMessageIds: ["msg_latest"],
      expectedContentSha256: { msg_latest: "a".repeat(64) },
      expectedTextPartSha256: { prt_text: "c".repeat(64) },
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
    // A visible TEXT part row must hash-match that part's raw text — not the
    // message-level sha of the first text part.
    const textRow = { ...base, partId: "prt_text", contentSha256: "c".repeat(64) }
    expect(paintedContentVerification(textRow, target)).toEqual({
      mode: "text-part-sha256",
      expectedSha256: "c".repeat(64),
      passed: true,
    })
    expect(semanticTimelinePaintReady(textRow, target)).toBe(true)
    expect(semanticTimelinePaintReady({ ...textRow, contentSha256: "d".repeat(64) }, target)).toBe(false)
    // A transformed part (tool/diff renders a summary) verifies identity +
    // painted text; an unknown part id fails.
    const toolRow = { ...base, partId: "prt_tool", contentSha256: "e".repeat(64) }
    expect(paintedContentVerification(toolRow, target)).toEqual({ mode: "part-identity", passed: true })
    expect(semanticTimelinePaintReady(toolRow, target)).toBe(true)
    expect(semanticTimelinePaintReady({ ...toolRow, textLength: 0 }, target)).toBe(false)
    expect(semanticTimelinePaintReady({ ...toolRow, partId: "prt_foreign" }, target)).toBe(false)
    // Rows without part identity (user rows) keep the message-level sha check.
    const userRow = { ...base, kind: "UserMessage" as const, partId: undefined, contentSha256: "a".repeat(64) }
    expect(semanticTimelinePaintReady(userRow, target)).toBe(true)
    expect(semanticTimelinePaintReady({ ...userRow, contentSha256: "f".repeat(64) }, target)).toBe(false)
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

  test("warms every work item before a seeded measured pass of real switches", () => {
    const targets = Array.from({ length: 20 }, (_, index) => ({
      sessionId: `session-${index}`,
      title: `Session ${index}`,
      expectedMessageIds: [`message-${index}`],
    }))
    const plan = warmSwitchPlan(targets, 42)

    expect(plan.warmup).toEqual(targets)
    expect(plan.measured).toHaveLength(20)
    expect(plan.measured.map((target) => target.sessionId).toSorted()).toEqual(
      targets.map((target) => target.sessionId).toSorted(),
    )
    expect(plan.measured[0]?.sessionId).not.toBe(plan.warmup.at(-1)?.sessionId)
  })
})

import { describe, expect, test } from "bun:test"
import {
  completeFirstFold,
  paintedContentVerification,
  seededSwitchSequence,
  semanticTimelinePaintReady,
  sessionReadyMode,
  warmSwitchPlan,
} from "../src/agent-browser-observer"

describe("session ready mode", () => {
  test("defaults to painted-and-input-ready and accepts Julius aliases", () => {
    const previous = process.env.AGENT_APP_BENCHMARK_SESSION_READY_MODE
    try {
      delete process.env.AGENT_APP_BENCHMARK_SESSION_READY_MODE
      expect(sessionReadyMode()).toBe("painted-and-input-ready")
      process.env.AGENT_APP_BENCHMARK_SESSION_READY_MODE = "dom-message-present"
      expect(sessionReadyMode()).toBe("dom-message-present")
      process.env.AGENT_APP_BENCHMARK_SESSION_READY_MODE = "last-message-in-dom"
      expect(sessionReadyMode()).toBe("dom-message-present")
      process.env.AGENT_APP_BENCHMARK_SESSION_READY_MODE = "DOM_MESSAGE_PRESENT"
      expect(sessionReadyMode()).toBe("dom-message-present")
    } finally {
      if (previous === undefined) delete process.env.AGENT_APP_BENCHMARK_SESSION_READY_MODE
      else process.env.AGENT_APP_BENCHMARK_SESSION_READY_MODE = previous
    }
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

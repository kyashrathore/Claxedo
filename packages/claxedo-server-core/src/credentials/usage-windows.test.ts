import { describe, expect, test } from "vitest"
import {
  clampPercent,
  codexWindowName,
  parseUsageWindows,
  serializeUsageWindows,
  usageResetMs,
  usageWindowName,
} from "./usage-windows"

describe("the vocabulary a vendor's usage answer is read into", () => {
  test("a slot Claxedo names reads the same whichever reader asked", () => {
    expect(usageWindowName("claude", "five_hour")).toBe("session")
    expect(usageWindowName("claude", "seven_day_opus")).toBe("weekly_opus")
    expect(usageWindowName("cursor", "primary_window")).toBe("plan")
  })

  test("primary means a session for Codex and the whole plan for Cursor", () => {
    expect(usageWindowName("codex", "primary_window")).toBe("session")
    expect(usageWindowName("cursor", "primary_window")).toBe("plan")
  })

  test("an unnamed slot keeps the vendor's own word rather than being invented a tier", () => {
    expect(usageWindowName("gemini", "primary_window")).toBe("primary_window")
    expect(usageWindowName("claude", "thirty_day")).toBe("thirty_day")
  })

  test("Codex's two readers name one window the same, though they count in different units", () => {
    // The HTTP read gives `limit_window_seconds`; the app-server gives
    // `windowDurationMins`. A plan with only a weekly limit delivers it in the
    // primary slot, which is why the slot cannot name it.
    expect(codexWindowName("primary_window", 18_000)).toBe("session")
    expect(codexWindowName("primary_window", 300 * 60)).toBe("session")
    expect(codexWindowName("primary_window", 604_800)).toBe("weekly")
    expect(codexWindowName("primary_window", 10_080 * 60)).toBe("weekly")
  })

  test("a duration Codex has not used before falls back to the slot's own name", () => {
    expect(codexWindowName("secondary_window", 99)).toBe("weekly")
    expect(codexWindowName("credit_window", undefined)).toBe("credits")
  })

  test("a percentage reaches a bar as a whole number inside the bar's range", () => {
    expect(clampPercent(60.4)).toBe(60)
    expect(clampPercent(60.6)).toBe(61)
    expect(clampPercent(-3)).toBe(0)
    expect(clampPercent(140)).toBe(100)
  })

  test("a reset time reads the same whether the vendor sent seconds, milliseconds or an ISO string", () => {
    expect(usageResetMs(1_789_311_600)).toBe(1_789_311_600_000)
    expect(usageResetMs(1_789_311_600_000)).toBe(1_789_311_600_000)
    expect(usageResetMs("2026-09-13T15:00:00.000Z")).toBe(Date.parse("2026-09-13T15:00:00.000Z"))
    expect(usageResetMs("never")).toBeNull()
    expect(usageResetMs(undefined)).toBeNull()
  })

  test("stored text that no longer describes windows reads as no usage", () => {
    const windows = [{ window: "session", usedPercent: 25, resetsAt: 1 }]
    expect(parseUsageWindows(serializeUsageWindows(windows))).toEqual(windows)
    expect(parseUsageWindows('[{"window":"session"}]')).toBeNull()
    expect(parseUsageWindows("not json")).toBeNull()
    expect(parseUsageWindows(null)).toBeNull()
  })
})

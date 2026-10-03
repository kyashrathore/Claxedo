import { describe, expect, test } from "vitest"
import { parseSessionReaderFilter } from "./navigation-reader"

test("activity filters accept the three explicit modes and refuse unknown selectors", () => {
  for (const activity of ["all", "working", "needs-you"]) {
    expect(parseSessionReaderFilter(new URLSearchParams({ activity })).activity).toBe(activity)
  }
  expect(() => parseSessionReaderFilter(new URLSearchParams({ activity: "other" }))).toThrow("Invalid session reader filter")
})

describe("session reader date filters", () => {
  test("requires real calendar dates, timezones, and a nonempty range", () => {
    for (const value of ["2026-02-30T00:00:00Z", "2026-13-01T00:00:00Z", "2026-10-01T24:00:00Z", "2026-10-01T00:00:00", "2026-10-01T00:00:00+24:00"]) {
      expect(() => parseSessionReaderFilter(new URLSearchParams({ dateField: "created", from: value }))).toThrow("Invalid session reader filter")
    }
    expect(() => parseSessionReaderFilter(new URLSearchParams({ from: "2026-10-01T00:00:00Z" }))).toThrow()
    expect(() => parseSessionReaderFilter(new URLSearchParams({ dateField: "activity", from: "2026-10-01T00:00:00Z", until: "2026-10-01T00:00:00Z" }))).toThrow()
  })

  test("normalizes timezone offsets without changing inclusive-start exclusive-end boundaries", () => {
    const result = parseSessionReaderFilter(new URLSearchParams({ dateField: "activity", from: "2026-10-01T05:30:00+05:30", until: "2026-10-02T00:00:00Z" }))
    expect(result).toMatchObject({ from: Date.parse("2026-10-01T00:00:00Z"), until: Date.parse("2026-10-02T00:00:00Z") })
  })
})

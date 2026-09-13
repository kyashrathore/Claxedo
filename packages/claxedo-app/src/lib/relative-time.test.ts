import { describe, expect, test } from "bun:test"
import { formatCompactAge, formatRelativeTime } from "./relative-time"

const MINUTE = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

describe("formatCompactAge", () => {
  test("says nothing below a minute, so the caller can put its own word there", () => {
    expect(formatCompactAge(Date.now() - 30_000)).toBeUndefined()
    expect(formatCompactAge(Date.now())).toBeUndefined()
  })

  test("is one unit and no space, in the bucket the sentence would have used", () => {
    expect(formatCompactAge(Date.now() - 5 * MINUTE)).toBe("5m")
    expect(formatCompactAge(Date.now() - 5 * HOUR)).toBe("5h")
    expect(formatCompactAge(Date.now() - 3 * DAY)).toBe("3d")
  })

  test("picks the same bucket the sentence picks, for the same instant", () => {
    const at = Date.now() - 5 * HOUR
    expect(formatCompactAge(at)).toBe("5h")
    expect(formatRelativeTime(at, "en")).toBe("5 hours ago")
  })

  test("counts a longer age without falling back to hours", () => {
    expect(formatCompactAge(Date.now() - 10 * DAY)).toBe("1w")
    expect(formatCompactAge(Date.now() - 60 * DAY)).toBe("2mo")
    expect(formatCompactAge(Date.now() - 400 * DAY)).toBe("1y")
  })
})

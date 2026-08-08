import { describe, expect, test } from "vitest"
import { unifiedUsageQuery, usageQueryKey } from "./usage-query"

describe("usage query", () => {
  test("keys cache by range, timezone, and group while retaining previous data", () => {
    const input = { since: 1, until: 2, timeZone: "UTC", group: "model" as const }
    expect(usageQueryKey(input)).toEqual(["usage-dashboard", 1, 2, "UTC", "model"])
    expect(unifiedUsageQuery(input).placeholderData).toBeTypeOf("function")
  })
})

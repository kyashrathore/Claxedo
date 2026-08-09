import { describe, expect, test } from "vitest"
import { unifiedUsageQuery, usageQueryKey } from "./usage-query"

describe("usage query", () => {
  test("keys cache by range, timezone, and group while retaining only the same view", () => {
    const input = {
      since: 1,
      until: 2,
      timeZone: "UTC",
      view: "total" as const,
      group: "model" as const,
      filters: { app: "claude", location: "local" },
      after: "cursor",
      modelAfter: "model-cursor",
      limit: 25,
    }
    expect(usageQueryKey(input)).toEqual([
      "usage-dashboard",
      1,
      2,
      "UTC",
      "total",
      "model",
      "app=claude&location=local",
      "cursor",
      "model-cursor",
      25,
      0,
    ])
    const placeholder = unifiedUsageQuery(input).placeholderData
    if (typeof placeholder !== "function") throw new Error("usage placeholder must be a function")
    const previous = {} as never
    expect(placeholder(previous, { queryKey: usageQueryKey(input) } as never)).toBe(previous)
    expect(
      placeholder(previous, {
        queryKey: usageQueryKey({ ...input, view: "claxedo" }),
      } as never),
    ).toBeUndefined()
    expect(
      placeholder(previous, {
        queryKey: usageQueryKey({ ...input, since: 0 }),
      } as never),
    ).toBeUndefined()
    expect(
      placeholder(previous, {
        queryKey: usageQueryKey({ ...input, after: "next-page", refreshNonce: 2 }),
      } as never),
    ).toBe(previous)
  })
})

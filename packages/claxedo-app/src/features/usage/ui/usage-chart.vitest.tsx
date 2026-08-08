import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, test } from "vitest"
import { UsageChart } from "./usage-chart"

afterEach(cleanup)

describe("UsageChart", () => {
  test("exposes every visual point to keyboard and screen readers", () => {
    render(() => <UsageChart metric="tokens" series={{
      totals: { turnCount: 1, input: 10, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, unknownCategories: 0 },
      daily: [{ date: "2026-08-08", turnCount: 1, input: 10, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, unknownCategories: 0 }],
    }} />)
    expect(screen.getByRole("img", { name: "Daily usage chart" })).toBeInTheDocument()
    expect(screen.getByRole("img", { name: "2026-08-08: 12 tokens" })).toHaveAttribute("tabindex", "0")
  })
})

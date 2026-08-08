import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, test } from "vitest"
import { UsageBreakdown } from "./usage-breakdown"

afterEach(cleanup)

describe("UsageBreakdown", () => {
  test("normalizes central rows into an accessible table", () => {
    render(() => <UsageBreakdown
      group="model"
      totals={{ turnCount: 1, input: 100, output: 20, reasoning: 0, cacheRead: 0, cacheWrite: 0, unknownCategories: 0 }}
      breakdown={{ central: { rows: [{ value: "anthropic/claude", turn_count: 1, input_tokens: 100, output_tokens: 20 }] } }}
    />)
    expect(screen.getByRole("table", { name: "Usage grouped by model" })).toBeInTheDocument()
    expect(screen.getByText("anthropic/claude")).toBeInTheDocument()
    expect(screen.getByText("100%")).toBeInTheDocument()
  })
})

import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"
import { UsageBreakdown } from "./usage-breakdown"

afterEach(cleanup)

describe("UsageBreakdown", () => {
  test("renders canonical priced rows, category coverage, drill-down, and pagination", () => {
    const next = vi.fn()
    render(() => (
      <UsageBreakdown
        group="model"
        totals={{
          turnCount: 1,
          input: 100,
          output: 20,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0,
          unknownCategories: 0,
        }}
        breakdown={{
          dimension: "model",
          rows: [
            {
              value: "anthropic/claude",
              label: "anthropic/claude",
              turnCount: 1,
              input: 100,
              output: 20,
              reasoning: 0,
              cacheRead: 0,
              cacheWrite: 0,
              unknownCategories: 0,
              estimatedUsd: 0.12,
              pricedTokens: 120,
              unpricedTokens: 0,
              status: "final",
              href: "/s/session-public",
            },
          ],
          next: "anthropic/claude",
        }}
        onNext={next}
      />
    ))
    expect(screen.getByRole("table", { name: "Usage grouped by model" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "anthropic/claude" })).toHaveAttribute("href", "/s/session-public")
    expect(screen.getByText("$0.12")).toBeInTheDocument()
    expect(screen.getByRole("row", { name: /anthropic\/claude/ })).toHaveAttribute(
      "title",
      "In 100 · Out 20 · Reason 0 · Cache 0 · All categories measured",
    )
    expect(screen.getByText("100%")).toBeInTheDocument()
    screen.getByRole("button", { name: "Next breakdown page" }).click()
    expect(next).toHaveBeenCalledWith("anthropic/claude")
  })

  test("disables cursor navigation while a page request is in flight", () => {
    const row = {
      value: "codex",
      label: "codex",
      turnCount: 1,
      input: 100,
      output: 20,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      unknownCategories: 0,
      estimatedUsd: 0.12,
      pricedTokens: 120,
      unpricedTokens: 0,
      status: "final" as const,
    }
    render(() => (
      <UsageBreakdown
        breakdown={{ dimension: "harness", rows: [row], next: "next" }}
        totals={row}
        group="harness"
        hasPrevious
        busy
      />
    ))
    expect(screen.getByRole("button", { name: "Previous breakdown page" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Next breakdown page" })).toBeDisabled()
  })
})

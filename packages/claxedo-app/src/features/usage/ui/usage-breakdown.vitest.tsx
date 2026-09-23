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

  test("a row whose every turn reported no token usage says so in place of zero tokens and cost", () => {
    const silent = {
      value: "connection:cursor-acp",
      label: "connection:cursor-acp",
      turnCount: 2,
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      unknownCategories: 10,
      estimatedUsd: 0,
      pricedTokens: 0,
      unpricedTokens: 0,
      status: "unavailable" as const,
    }
    const unbranded = { ...silent, value: "some-agent", label: "some-agent" }
    render(() => (
      <UsageBreakdown breakdown={{ dimension: "harness", rows: [silent, unbranded] }} totals={silent} group="harness" />
    ))
    const cursor = screen.getByRole("row", { name: /connection:cursor-acp/ })
    expect(cursor).toHaveTextContent("Cursor doesn't report token usage")
    expect(cursor).not.toHaveTextContent("$0.00")
    expect(cursor).not.toHaveTextContent("0%")
    expect(cursor).toHaveAttribute("title", expect.stringContaining("Cursor doesn't report token usage"))
    expect(screen.getByRole("row", { name: /some-agent/ })).toHaveTextContent("Doesn't report token usage")
  })
})

import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, test } from "vitest"
import { UsageChart } from "./usage-chart"

afterEach(cleanup)

describe("UsageChart", () => {
  test("exposes the chart summary and a keyboard-accessible nearest-day tooltip", () => {
    const view = render(() => (
      <UsageChart
        metric="tokens"
        series={{
          totals: {
            turnCount: 1,
            input: 10,
            output: 2,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
            unknownCategories: 0,
          },
          daily: [
            {
              date: "2026-08-08",
              turnCount: 1,
              input: 10,
              output: 2,
              reasoning: 0,
              cacheRead: 0,
              cacheWrite: 0,
              unknownCategories: 0,
            },
          ],
        }}
      />
    ))
    expect(screen.getByRole("img", { name: /Daily tokens by total.*Daily total/ })).toBeInTheDocument()
    const plot = view.container.querySelector(".usage-chart-plot")!
    expect(plot).toHaveAttribute("tabindex", "0")
    fireEvent.focus(plot)
    expect(screen.getByRole("status")).toHaveTextContent("Aug 8, 2026")
    expect(screen.getByRole("status")).toHaveTextContent("12 tokens")
  })

  test("renders provider-token series for each grouped value", () => {
    const view = render(() => (
      <UsageChart
        metric="tokens"
        series={{
          totals: {
            turnCount: 2,
            input: 30,
            output: 6,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
            unknownCategories: 0,
          },
          daily: [],
        }}
        chart={{
          dimension: "harness",
          series: [
            {
              value: "codex",
              label: "Codex",
              daily: [{ date: "2026-08-08", input: 10, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0 }],
            },
            {
              value: "claude",
              label: "Claude",
              daily: [{ date: "2026-08-08", input: 20, output: 4, reasoning: 0, cacheRead: 0, cacheWrite: 0 }],
            },
          ],
        }}
      />
    ))
    expect(screen.getByText("Codex")).toBeInTheDocument()
    expect(screen.getByText("Claude")).toBeInTheDocument()
    fireEvent.focus(view.container.querySelector(".usage-chart-plot")!)
    expect(screen.getByRole("status")).toHaveTextContent("Codex12 tokens")
    expect(screen.getByRole("status")).toHaveTextContent("Claude24 tokens")
    expect(screen.getByRole("status")).toHaveTextContent("Total36 tokens")
  })

  test("charts daily estimated cost instead of replacing the chart with one aggregate", () => {
    const view = render(() => (
      <UsageChart
        metric="cost"
        series={{
          totals: {
            turnCount: 1,
            input: 10,
            output: 2,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
            unknownCategories: 0,
          },
          daily: [
            {
              date: "2026-08-08",
              turnCount: 1,
              input: 10,
              output: 2,
              reasoning: 0,
              cacheRead: 0,
              cacheWrite: 0,
              unknownCategories: 0,
            },
          ],
        }}
        cost={{
          estimatedUsd: 0.125,
          pricedTokens: 12,
          unpricedTokens: 0,
          catalog: { adapter: "tokentracker", version: "0.75.1", source: "seed" },
          daily: [{ date: "2026-08-08", estimatedUsd: 0.125, pricedTokens: 12, unpricedTokens: 0 }],
        }}
      />
    ))
    fireEvent.focus(view.container.querySelector(".usage-chart-plot")!)
    expect(screen.getByRole("status")).toHaveTextContent("$0.13")
  })

  test("stacks retained series, rolls the tail into Other, and reconciles the tooltip total", () => {
    const chartSeries = Array.from({ length: 7 }, (_, index) => ({
      value: `provider-${index + 1}`,
      label: `Provider ${index + 1}`,
      daily: [{
        date: "2026-08-08",
        input: index + 1,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
      }],
    }))
    const view = render(() => (
      <UsageChart
        metric="tokens"
        series={{
          totals: {
            turnCount: 7,
            input: 28,
            output: 0,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
            unknownCategories: 0,
          },
          daily: [],
        }}
        chart={{ dimension: "provider", series: chartSeries }}
      />
    ))

    expect(screen.getByText("Other")).toBeInTheDocument()
    expect(screen.queryByText("Provider 1")).not.toBeInTheDocument()
    expect(screen.queryByText("Provider 2")).not.toBeInTheDocument()
    const areas = [...view.container.querySelectorAll<SVGPathElement>(".usage-chart-area")]
    expect(areas).toHaveLength(6)
    expect(areas[0]).toHaveAttribute("data-stack-bottom", "0")
    expect(areas[1]).toHaveAttribute("data-stack-bottom", "7")

    fireEvent.focus(view.container.querySelector(".usage-chart-plot")!)
    expect(screen.getByRole("status")).toHaveTextContent("Other3 tokens")
    expect(screen.getByRole("status")).toHaveTextContent("Total28 tokens")
  })
})

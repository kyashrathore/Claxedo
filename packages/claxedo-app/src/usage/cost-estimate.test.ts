/// <reference types="bun" />
import { describe, expect, test } from "bun:test"
import { costEstimate } from "./cost-estimate"
import type { UsageTotals } from "./model"

const totals = (patch: Partial<UsageTotals> = {}): UsageTotals => ({
  turnCount: 4,
  input: 3_010,
  output: 1_000_000,
  reasoning: 134_000,
  cacheRead: 310_000_000,
  cacheWrite: 15_000_000,
  unknownCategories: 0,
  ...patch,
})

const priced = (estimatedUsd: number, pricedTokens: number, unpricedTokens: number) => ({ estimatedUsd, pricedTokens, unpricedTokens })

describe("costEstimate", () => {
  test("tokens with no price at all are an unknown cost, not $0.00", () => {
    expect(costEstimate(priced(0, 0, 326_137_010), totals())).toEqual({ kind: "unknown" })
  })

  test("tokens the pricer never saw are an unknown cost too", () => {
    expect(costEstimate(priced(0, 0, 0), totals())).toEqual({ kind: "unknown" })
  })

  test("turns that reported no usage leave the cost unknown", () => {
    const silent = totals({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, unavailableTurnCount: 2 })
    expect(costEstimate(priced(0, 0, 0), silent)).toEqual({ kind: "unknown" })
  })

  test("some priced and some unpriced tokens are a lower bound", () => {
    expect(costEstimate(priced(12.4, 300_000_000, 26_137_010), totals())).toEqual({ kind: "partial", usd: 12.4 })
  })

  test("every token priced is the estimate", () => {
    expect(costEstimate(priced(12.4, 326_137_010, 0), totals())).toEqual({ kind: "complete", usd: 12.4 })
  })

  test("no turns cost nothing", () => {
    const none = totals({ turnCount: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
    expect(costEstimate(priced(0, 0, 0), none)).toEqual({ kind: "none" })
  })
})

/// <reference types="bun" />
import { describe, expect, test } from "bun:test"
import { axisLabelIndexes, dailyCost, dailyTokens, niceCeiling, rangeDates } from "./daily-series"
import type { UsageTotals } from "./model"

const range = (since: string, until: string, timeZone = "UTC") => ({ since: Date.parse(since), until: Date.parse(until), timeZone })
const day = (date: string, tokens: number): UsageTotals & { date: string } => ({ date, turnCount: 1, input: tokens, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, unknownCategories: 0 })

describe("rangeDates", () => {
  test("names every local day of the range once", () => {
    expect(rangeDates(range("2026-09-22T00:00:00Z", "2026-09-28T23:59:59.999Z"))).toEqual([
      "2026-09-22",
      "2026-09-23",
      "2026-09-24",
      "2026-09-25",
      "2026-09-26",
      "2026-09-27",
      "2026-09-28",
    ])
  })

  test("keeps one entry per day across a daylight-saving change", () => {
    const dates = rangeDates(range("2026-10-24T22:00:00Z", "2026-10-27T22:59:59.999Z", "Europe/Berlin"))
    expect(dates).toEqual(["2026-10-25", "2026-10-26", "2026-10-27"])
  })
})

describe("dailyTokens", () => {
  test("a day without turns is a measured zero", () => {
    const dates = ["2026-09-26", "2026-09-27", "2026-09-28"]
    expect(dailyTokens(dates, [day("2026-09-27", 40)])).toEqual([
      { date: "2026-09-26", value: 0 },
      { date: "2026-09-27", value: 40 },
      { date: "2026-09-28", value: 0 },
    ])
  })
})

describe("dailyCost", () => {
  test("a day whose tokens have no price is unknown", () => {
    const dates = ["2026-09-27", "2026-09-28"]
    const cost = [
      { date: "2026-09-27", estimatedUsd: 0, pricedTokens: 0, unpricedTokens: 900 },
      { date: "2026-09-28", estimatedUsd: 1.5, pricedTokens: 1_000, unpricedTokens: 0 },
    ]
    expect(dailyCost(dates, cost)).toEqual([
      { date: "2026-09-27", value: null },
      { date: "2026-09-28", value: 1.5 },
    ])
  })

  test("a server that sends no daily cost has no daily cost to draw", () => {
    expect(dailyCost(["2026-09-28"], undefined)).toBeUndefined()
  })
})

describe("niceCeiling", () => {
  test("rounds the peak up to a readable axis top", () => {
    expect([0, 0.4, 7, 180, 214_000_000, 250].map(niceCeiling)).toEqual([0, 0.5, 10, 200, 250_000_000, 250])
  })
})

describe("axisLabelIndexes", () => {
  test("labels every day of a week and five evenly spread days of a longer range", () => {
    expect(axisLabelIndexes(7)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(axisLabelIndexes(30)).toEqual([0, 7, 15, 22, 29])
    expect(axisLabelIndexes(90)).toEqual([0, 22, 45, 67, 89])
  })
})

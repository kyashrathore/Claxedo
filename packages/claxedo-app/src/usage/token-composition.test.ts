/// <reference types="bun" />
import { expect, test } from "bun:test"
import { tokenComposition } from "./token-composition"

test("splits the context the model read from what it generated, each with its share of every token", () => {
  const composition = tokenComposition({ turnCount: 1, input: 10, output: 20, reasoning: 10, cacheRead: 150, cacheWrite: 10, unknownCategories: 0 })
  expect(composition.total).toBe(200)
  expect(composition.context).toEqual([
    { category: "cacheRead", tokens: 150, share: 0.75 },
    { category: "cacheWrite", tokens: 10, share: 0.05 },
    { category: "input", tokens: 10, share: 0.05 },
  ])
  expect(composition.generated).toEqual([
    { category: "output", tokens: 20, share: 0.1 },
    { category: "reasoning", tokens: 10, share: 0.05 },
  ])
})

test("no tokens share nothing instead of dividing by zero", () => {
  const composition = tokenComposition({ turnCount: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, unknownCategories: 0 })
  expect([...composition.context, ...composition.generated].map((part) => part.share)).toEqual([0, 0, 0, 0, 0])
})

import { expect, test } from "bun:test"
import { backgroundWorkActive, NO_BACKGROUND_WORK, parseBackgroundWork, sameBackgroundWork } from "./background-work"

test("background work is active while any kind has a task, and a wire value parses only as whole counts", () => {
  expect(backgroundWorkActive(NO_BACKGROUND_WORK)).toBe(false)
  expect(backgroundWorkActive({ agents: 0, shells: 1, other: 0 })).toBe(true)
  expect(parseBackgroundWork({ agents: 2, shells: 1, other: 0, extra: true })).toEqual({ agents: 2, shells: 1, other: 0 })
  expect(parseBackgroundWork({ agents: 2, shells: 1 })).toBeUndefined()
  expect(parseBackgroundWork({ agents: -1, shells: 0, other: 0 })).toBeUndefined()
  expect(parseBackgroundWork({ agents: 1.5, shells: 0, other: 0 })).toBeUndefined()
  expect(parseBackgroundWork(true)).toBeUndefined()
  expect(sameBackgroundWork({ agents: 1, shells: 0, other: 0 }, { agents: 1, shells: 0, other: 0 })).toBe(true)
  expect(sameBackgroundWork({ agents: 1, shells: 0, other: 0 }, { agents: 0, shells: 1, other: 0 })).toBe(false)
})

/// <reference types="bun" />
import { expect, test } from "bun:test"
import { pendingTitle } from "./pending-title"

test("a new session reads its prompt's title until the server names it", () => {
  expect(pendingTitle(undefined, "Reply with exactly LIVE-OK-2 and the output of `git rev-parse --abbrev-ref HEAD`.")).toBe("Reply with exactly LIVE-OK-2 and the output of git rev-parse…")
  expect(pendingTitle("Named", "Fix the login bug")).toBe("Named")
  expect(pendingTitle(undefined, undefined)).toBe("")
})

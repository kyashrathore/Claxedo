/// <reference types="bun" />
import { expect, test } from "bun:test"
import { pendingTitle } from "./pending-title"

test("a new session reads the first words of its prompt until the server names it", () => {
  expect(pendingTitle(undefined, "Fix the login\nbug")).toBe("Fix the login bug")
  expect(pendingTitle(undefined, "Refactor the session list so every pending row reads the first words of the prompt")).toBe("Refactor the session list so every pending row reads the…")
  expect(pendingTitle("Named", "Fix the login bug")).toBe("Named")
  expect(pendingTitle(undefined, undefined)).toBe("")
})

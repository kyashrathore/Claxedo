import { expect, test } from "bun:test"
import { promptTitle } from "./prompt-title"

test("a prompt's title starts at its first word, cut at a word boundary", () => {
  expect(promptTitle("Fix the login\nbug")).toBe("Fix the login bug")
  expect(promptTitle("Refactor the session list so every pending row reads the first words of the prompt")).toBe("Refactor the session list so every pending row reads the…")
  expect(promptTitle("Reply with exactly LIVE-OK-2 and the output of `git rev-parse --abbrev-ref HEAD`.")).toBe("Reply with exactly LIVE-OK-2 and the output of git rev-parse…")
})

test("a prompt's title drops markdown punctuation and keeps code identifiers", () => {
  expect(promptTitle("## Fix **the** [login page](https://example.com/login)\n> keep `snake_case` and __init__ names")).toBe("Fix the login page keep snake_case and __init__ names")
  expect(promptTitle("- first item\n1. second item")).toBe("first item second item")
})

test("a greeting is titled Greeting and a polite opening is dropped", () => {
  expect(promptTitle("hello!")).toBe("Greeting")
  expect(promptTitle("Please fix the terminal pane")).toBe("fix the terminal pane")
  expect(promptTitle("")).toBe("")
})

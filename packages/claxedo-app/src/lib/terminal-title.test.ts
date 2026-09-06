import { describe, expect, test } from "bun:test"
import { defaultTitleNumber } from "@/lib/terminal-title"

describe("defaultTitleNumber", () => {
  test("reads the number out of the English default title", () => {
    expect(defaultTitleNumber("Terminal 1")).toBe(1)
    expect(defaultTitleNumber("Terminal 42")).toBe(42)
  })

  test("reads localized default titles, which the English-only regexes missed", () => {
    expect(defaultTitleNumber("ターミナル 3")).toBe(3)
    expect(defaultTitleNumber("终端 7")).toBe(7)
    expect(defaultTitleNumber("Терминал 2")).toBe(2)
  })

  test("a renamed terminal has no default number", () => {
    expect(defaultTitleNumber("build watcher")).toBeUndefined()
    expect(defaultTitleNumber("Terminal")).toBeUndefined()
    expect(defaultTitleNumber("Terminal 2 (build)")).toBeUndefined()
    expect(defaultTitleNumber("my Terminal 2")).toBeUndefined()
  })

  test("zero is not a terminal number", () => {
    expect(defaultTitleNumber("Terminal 0")).toBeUndefined()
  })
})

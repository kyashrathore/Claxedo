import { describe, expect, test } from "bun:test"
import { createStarterPrompts } from "./starter-prompts"

describe("starter prompts", () => {
  test("returns two stable prompts and a README-derived prompt", () => {
    expect(createStarterPrompts({
      files: ["README.md", "src/index.ts"],
      readme: "# Acme Scheduler\n\nA tiny scheduler.",
      todos: [],
    })).toEqual([
      "Explain how this codebase is organized",
      "Find and fix a TODO",
      "Show me how Acme Scheduler is implemented",
    ])
  })

  test("uses the first TODO when the README has no heading", () => {
    expect(createStarterPrompts({
      files: ["src/main.py"],
      todos: [{ path: "src/main.py", line: 12, text: "TODO: handle retries" }],
    })[2]).toBe("Handle the TODO in src/main.py:12: handle retries")
  })

  test("falls back to the dominant language deterministically", () => {
    expect(createStarterPrompts({
      files: ["src/a.ts", "src/b.tsx", "scripts/build.py", "vendor/x.py"],
      todos: [],
    })[2]).toBe("Trace the main TypeScript execution path")
  })

  test("uses a useful generic repo prompt when no signal is available", () => {
    expect(createStarterPrompts({ files: [], todos: [] })[2]).toBe("Identify the best place to make a small first improvement")
  })
})

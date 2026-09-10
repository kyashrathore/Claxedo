import { describe, expect, test } from "bun:test"
import { canonicalToolName, toolNameAliases } from "./tool-names"

describe("canonicalToolName", () => {
  test("lowercases a harness's own casing", () => {
    expect(["Bash", "Read", "Grep", "Glob", "Write"].map(canonicalToolName)).toEqual([
      "bash",
      "read",
      "grep",
      "glob",
      "write",
    ])
  })

  test("folds the spellings that named the same tool differently", () => {
    expect(canonicalToolName("Agent")).toBe("task")
    expect(canonicalToolName("LS")).toBe("list")
    expect(canonicalToolName("MultiEdit")).toBe("edit")
    expect(canonicalToolName("AskUserQuestion")).toBe("question")
    expect(canonicalToolName("local_shell")).toBe("bash")
    expect(canonicalToolName("read_file")).toBe("read")
  })

  test("leaves an unknown tool as its lowercase self", () => {
    expect(canonicalToolName("mcp__Plugin_PostHog__exec")).toBe("mcp__plugin_posthog__exec")
    expect(canonicalToolName("toolsearch")).toBe("toolsearch")
  })

  test("is idempotent, so canonicalising twice cannot drift", () => {
    for (const [alias] of toolNameAliases()) {
      expect(canonicalToolName(canonicalToolName(alias))).toBe(canonicalToolName(alias))
    }
  })
})

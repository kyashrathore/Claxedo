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
    expect(canonicalToolName("AskUserQuestion")).toBe("question")
    expect(canonicalToolName("local_shell")).toBe("bash")
    expect(canonicalToolName("read_file")).toBe("read")
  })

  test("keeps multiedit off the edit renderer, which cannot read an edits[] array", () => {
    expect(canonicalToolName("MultiEdit")).toBe("multiedit")
  })

  test("leaves an unknown tool as its lowercase self", () => {
    expect(canonicalToolName("mcp__Plugin_PostHog__exec")).toBe("mcp__plugin_posthog__exec")
    expect(canonicalToolName("toolsearch")).toBe("toolsearch")
  })

  test("reads prototype keys as absent, never as inherited members", () => {
    for (const key of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
      expect(canonicalToolName(key)).toBe(key.toLowerCase())
    }
  })

  test("is idempotent, so canonicalising twice cannot drift", () => {
    for (const [alias] of toolNameAliases()) {
      expect(canonicalToolName(canonicalToolName(alias))).toBe(canonicalToolName(alias))
    }
  })
})

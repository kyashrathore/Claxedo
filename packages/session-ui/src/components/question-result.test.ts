import { describe, expect, test } from "bun:test"
import { isQuestionDeclined } from "./question-result"

/**
 * Verbatim from `~/.claude/projects/**\/*.jsonl`: the only two error payloads any
 * `AskUserQuestion` tool_result carries, across 30 occurrences.
 */
const DISMISSED = "User dismissed the question"
const REJECTED =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.\n\nNote: The user's next message may contain a correction or preference. Pay close attention — if they explain what went wrong or how they'd prefer you to work, consider saving that to memory for future sessions."

describe("isQuestionDeclined", () => {
  test("accepts the dismissal the claude driver writes", () => {
    expect(isQuestionDeclined(DISMISSED)).toBe(true)
  })

  test("accepts the rejection the CLI writes", () => {
    expect(isQuestionDeclined(REJECTED)).toBe(true)
  })

  test("accepts the dismissal through the harness's Error prefix", () => {
    expect(isQuestionDeclined(`Error: ${DISMISSED}`)).toBe(true)
  })

  test("rejects a real failure", () => {
    expect(isQuestionDeclined("Claude AskUserQuestion requires a non-empty questions array")).toBe(false)
  })

  test("rejects a failure that merely quotes a decline", () => {
    expect(isQuestionDeclined(`Tool crashed while reporting: ${DISMISSED}`)).toBe(false)
  })
})

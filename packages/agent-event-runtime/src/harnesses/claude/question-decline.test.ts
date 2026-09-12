import { describe, expect, test } from "bun:test"
import { CLAUDE_QUESTION_DISMISSED, isClaudeQuestionDecline } from "./question-decline"

/**
 * Verbatim from `~/.claude/projects/**\/*.jsonl`: the only two error payloads any
 * `AskUserQuestion` tool_result carries, across 30 occurrences.
 */
const REJECTED =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.\n\nNote: The user's next message may contain a correction or preference. Pay close attention — if they explain what went wrong or how they'd prefer you to work, consider saving that to memory for future sessions."

describe("isClaudeQuestionDecline", () => {
  test("accepts the dismissal the driver denies with", () => {
    expect(isClaudeQuestionDecline(CLAUDE_QUESTION_DISMISSED)).toBe(true)
  })

  test("accepts the rejection the CLI writes, guidance and all", () => {
    expect(isClaudeQuestionDecline(REJECTED)).toBe(true)
  })

  test("rejects a real failure", () => {
    expect(isClaudeQuestionDecline("Claude AskUserQuestion requires a non-empty questions array")).toBe(false)
  })

  test("rejects a failure that merely quotes a decline", () => {
    expect(isClaudeQuestionDecline(`Tool crashed while reporting: ${CLAUDE_QUESTION_DISMISSED}`)).toBe(false)
  })
})

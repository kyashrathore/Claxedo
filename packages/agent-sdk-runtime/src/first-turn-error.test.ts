import { describe, expect, test } from "bun:test"
import { classifyFirstTurnError, firstTurnErrorData } from "./first-turn-error"

describe("first-turn error taxonomy", () => {
  test.each([
    ["401 Unauthorized: invalid API key", "credential"],
    ["OAuth token expired", "credential"],
    ["ACP harness process failed to start", "harness"],
    ["unsupported adapter capability", "harness"],
    ["harness_switch_not_supported", "harness"],
    ["Model claude-missing was not found", "model"],
    ["provider/model selection is required", "model"],
    ["workspace is not ready", "workspace"],
    ["ENOENT: repository directory does not exist", "workspace"],
    ["thread not found: 019f73fb-1234-4abc-8def-0123456789ab", "session"],
    ["session not found", "session"],
    ["no such thread", "session"],
  ] as const)("classifies %s as %s", (message, expected) => {
    expect(classifyFirstTurnError(message)).toBe(expected)
  })

  test("unclassifiable failures fall back to unknown, not workspace", () => {
    expect(classifyFirstTurnError("connection closed unexpectedly")).toBe("unknown")
    expect(classifyFirstTurnError("Stream error")).toBe("unknown")
  })

  test("attaches the typed class without replacing the original message", () => {
    expect(firstTurnErrorData("401 Unauthorized")).toEqual({
      message: "401 Unauthorized",
      firstTurnErrorClass: "credential",
    })
  })
})

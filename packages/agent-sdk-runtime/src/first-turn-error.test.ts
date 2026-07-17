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
  ] as const)("classifies %s as %s", (message, expected) => {
    expect(classifyFirstTurnError(message)).toBe(expected)
  })

  test("unknown failures fall back to workspace recovery", () => {
    expect(classifyFirstTurnError("connection closed unexpectedly")).toBe("workspace")
  })

  test("attaches the typed class without replacing the original message", () => {
    expect(firstTurnErrorData("401 Unauthorized")).toEqual({
      message: "401 Unauthorized",
      firstTurnErrorClass: "credential",
    })
  })
})

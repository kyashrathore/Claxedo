import { describe, expect, test } from "bun:test"
import { classifyProvisionFailure, readyProvisionDirectory } from "./provision-failure"

describe("provision failure taxonomy", () => {
  test.each([
    ["API key rejected with 401 unauthorized", "bad_key", "Update API key"],
    ["Account has no payment method", "no_payment_method", "Open provider billing"],
    ["Sandbox quota exceeded", "quota", "Review provider quota"],
    ["Selected region is unavailable", "region", "Choose another region"],
    ["Clone failed unexpectedly", "unknown", "Retry provisioning"],
  ] as const)("classifies %s", (message, expectedClass, expectedAction) => {
    expect(classifyProvisionFailure(message)).toMatchObject({ class: expectedClass, action: expectedAction })
  })

  test("does not navigate until the provision is explicitly ready", () => {
    expect(readyProvisionDirectory("waiting_health", "/workspace/repo")).toBeUndefined()
    expect(readyProvisionDirectory("error", "/workspace/repo")).toBeUndefined()
    expect(readyProvisionDirectory(undefined, "/workspace/repo")).toBeUndefined()
    expect(readyProvisionDirectory("ready", "/workspace/repo")).toBe("/workspace/repo")
  })
})

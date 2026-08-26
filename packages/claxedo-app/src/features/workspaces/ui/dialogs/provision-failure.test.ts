import { describe, expect, test } from "bun:test"
import { classifyProvisionFailure, readyProvisionDirectory } from "./provision-failure"

describe("provision failure taxonomy", () => {
  test.each([
    ["API key rejected with 401 unauthorized", "bad_key", "Review provider account", "provider-account"],
    ["Account has no payment method", "no_payment_method", "Review provider account", "provider-account"],
    ["Sandbox quota exceeded", "quota", "Review provider account", "provider-account"],
    ["Selected region is unavailable", "region", "Choose another provider", "choose-provider"],
    ["Clone failed unexpectedly", "unknown", "Retry provisioning", "retry"],
  ] as const)("classifies %s", (message, expectedClass, expectedAction, expectedFix) => {
    expect(classifyProvisionFailure(message)).toMatchObject({
      class: expectedClass,
      action: expectedAction,
      fix: expectedFix,
    })
  })

  test("does not navigate until the provision is explicitly ready", () => {
    expect(readyProvisionDirectory("waiting_health", "/workspace/repo")).toBeUndefined()
    expect(readyProvisionDirectory("error", "/workspace/repo")).toBeUndefined()
    expect(readyProvisionDirectory(undefined, "/workspace/repo")).toBeUndefined()
    expect(readyProvisionDirectory("ready", "/workspace/repo")).toBe("/workspace/repo")
  })
})

import { describe, expect, test } from "bun:test"
import { e2eAuthViteEnvironment, resolveE2EAuthMode } from "./auth-mode"

describe("E2E auth mode", () => {
  test("accepts each canonical mode", () => {
    expect(resolveE2EAuthMode("test-user")).toBe("test-user")
    expect(resolveE2EAuthMode("local-unsigned")).toBe("local-unsigned")
  })

  test("rejects an unknown mode before building or serving", () => {
    expect(() => resolveE2EAuthMode("signed-production")).toThrow(
      'CLAXEDO_E2E_AUTH_MODE="signed-production" is not known. Known modes: test-user, local-unsigned.',
    )
  })

  test("owns the complete build-time auth environment", () => {
    expect(e2eAuthViteEnvironment("test-user")).toEqual({
      VITE_AUTH_ENABLED: "true",
      VITE_CLAXEDO_DISABLE_TEST_AUTH_BYPASS: "0",
      VITE_SANDBOX_ENABLED: "true",
    })
    expect(e2eAuthViteEnvironment("local-unsigned")).toEqual({
      VITE_AUTH_ENABLED: "true",
      VITE_CLAXEDO_DISABLE_TEST_AUTH_BYPASS: "1",
      VITE_CLERK_PUBLISHABLE_KEY: "",
      VITE_SANDBOX_ENABLED: "true",
    })
  })
})

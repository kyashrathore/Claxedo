import { describe, expect, test } from "bun:test"
import { e2eAppViteEnvironment, resolveE2EAuthMode } from "./auth-mode"
import { resolveBrowserAuthBuildSelection } from "../vite.browser-auth"

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

  test("owns the complete build environment every e2e vite launcher passes", () => {
    expect(e2eAppViteEnvironment("test-user")).toEqual({
      VITE_AUTH_ENABLED: "true",
      VITE_CLAXEDO_DISABLE_TEST_AUTH_BYPASS: "0",
      VITE_SANDBOX_ENABLED: "true",
      VITE_CLAXEDO_SETTINGS_CONNECTIONS_ENABLED: "true",
      VITE_CLAXEDO_SETTINGS_SANDBOX_PROVIDERS_ENABLED: "true",
      VITE_CLAXEDO_AUTH_ADAPTER: "better-auth",
      VITE_CLAXEDO_E2E: "1",
    })
    expect(e2eAppViteEnvironment("local-unsigned")).toEqual({
      VITE_AUTH_ENABLED: "true",
      VITE_CLAXEDO_DISABLE_TEST_AUTH_BYPASS: "1",
      VITE_SANDBOX_ENABLED: "true",
      VITE_CLAXEDO_SETTINGS_CONNECTIONS_ENABLED: "true",
      VITE_CLAXEDO_SETTINGS_SANDBOX_PROVIDERS_ENABLED: "true",
      VITE_CLAXEDO_AUTH_ADAPTER: "better-auth",
      VITE_CLAXEDO_E2E: "1",
    })
  })

  test("names an adapter vite.cloud.config.ts will accept", () => {
    // `resolveBrowserAuthBuildSelection` throws on anything else, and it throws
    // while vite loads its config — i.e. before any launcher can listen.
    expect(() => resolveBrowserAuthBuildSelection(e2eAppViteEnvironment().VITE_CLAXEDO_AUTH_ADAPTER)).not.toThrow()
  })
})

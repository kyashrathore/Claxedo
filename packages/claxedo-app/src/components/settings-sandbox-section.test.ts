import { describe, expect, test } from "bun:test"
import {
  shouldUseSandboxDriverMutations,
  workspaceDefaultProviderUrl,
  workspaceProviderAuthUrl,
  workspaceProvidersUrl,
} from "./settings-sandbox-section-helpers"

describe("sandbox settings section", () => {
  test("keeps sandbox provider credential mutations on the local control plane", () => {
    expect(shouldUseSandboxDriverMutations({})).toBe(true)
    expect(
      shouldUseSandboxDriverMutations({
        baseUrl: "https://claxedo.example.test",
      }),
    ).toBe(false)
    expect(
      shouldUseSandboxDriverMutations({
        baseUrl: "http://127.0.0.1:3001",
      }),
    ).toBe(true)
  })

  test("builds sandbox provider control-plane URLs locally", () => {
    expect(workspaceProvidersUrl({ baseUrl: "https://control.example.test/" })).toBe(
      "https://control.example.test/api/workspace/providers",
    )
    expect(workspaceProviderAuthUrl({
      baseUrl: "https://control.example.test/",
      providerId: "daytona/custom",
    })).toBe("https://control.example.test/api/workspace/providers/daytona%2Fcustom/auth")
    expect(workspaceDefaultProviderUrl({ baseUrl: "https://control.example.test/" })).toBe(
      "https://control.example.test/api/workspace/providers/default",
    )
  })
})

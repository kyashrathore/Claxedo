import { describe, expect, test } from "bun:test"
import {
  shouldUseSandboxDriverMutations,
  workspaceDefaultSandboxDriverUrl,
  workspaceSandboxDriverAuthUrl,
  workspaceSandboxDriversUrl,
} from "./sandbox-section-logic"

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

  // These are string assertions only. What actually binds them to a server that
  // answers is `sandbox-driver-routes.contract.test.ts` in claxedo-server.
  test("builds sandbox driver control-plane URLs locally", () => {
    expect(workspaceSandboxDriversUrl({ baseUrl: "https://control.example.test/" })).toBe(
      "https://control.example.test/api/workspace/drivers",
    )
    expect(
      workspaceSandboxDriverAuthUrl({
        baseUrl: "https://control.example.test/",
        driverId: "daytona/custom",
      }),
    ).toBe("https://control.example.test/api/workspace/drivers/daytona%2Fcustom/auth")
    expect(workspaceDefaultSandboxDriverUrl({ baseUrl: "https://control.example.test/" })).toBe(
      "https://control.example.test/api/workspace/drivers/default",
    )
  })
})

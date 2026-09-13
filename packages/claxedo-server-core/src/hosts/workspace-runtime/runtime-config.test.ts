import { describe, expect, test } from "vitest"
import { createClaxedoAppliedRuntimeConfig } from "./runtime-config"

describe("applied runtime config", () => {
  test("refuses to resolve a shared-scope snapshot in this process", async () => {
    // A shared-scope projection names variables the sandbox's own provider
    // fills. Resolving it here would mark every one of them missing from the
    // server's environment and hand the sandbox a config that refuses its own
    // credentials.
    await expect(createClaxedoAppliedRuntimeConfig({ secretScope: "shared", workspaceId: "ws_1" }))
      .rejects.toThrow(/inside its own sandbox/)
  })
})

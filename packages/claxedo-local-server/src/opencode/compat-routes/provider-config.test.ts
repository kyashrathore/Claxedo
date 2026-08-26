import { describe, expect, test } from "vitest"
import { globalConfigBody } from "./provider-config"

describe("globalConfigBody", () => {
  test("serves Claxedo's own config without touching the OpenCode engine", async () => {
    // The engine seam is reached through global fetch in this composition.
    // Failing it outright proves the route no longer depends on the engine:
    // this used to round-trip for the OpenCode harness, which made the app's
    // first request on first paint fail with a 502 whenever the engine could
    // not load — and would keep failing after the SDK cutover, where the call
    // maps to config.get and returns 500 on an embedded host.
    const previousFetch = globalThis.fetch
    let engineCalls = 0
    globalThis.fetch = Object.assign(
      async () => {
        engineCalls += 1
        throw new Error("the engine must not be consulted for /global/config")
      },
      { preconnect: previousFetch.preconnect },
    ) as typeof globalThis.fetch

    try {
      const body = await globalConfigBody("opencode", { env: {} })
      expect(engineCalls).toBe(0)
      // Claxedo's Agent Config shape: model, provider, mcp.
      expect(body).toHaveProperty("mcp")
      expect(body).toHaveProperty("provider")
      expect(body).toHaveProperty("model")
    } finally {
      globalThis.fetch = previousFetch
    }
  })

  test("is harness-neutral: OpenCode gets the same body as every other harness", async () => {
    const forOpencode = await globalConfigBody("opencode", { env: {} })
    const forClaude = await globalConfigBody("claude-acp", { env: {} })
    // OpenCode used to be the odd one out here. Agent Config is authoritative
    // for all of them now, so the bodies must agree.
    expect(forOpencode).toEqual(forClaude)
  })
})

import { describe, expect, test } from "bun:test"
import { codexBundlePiBackendResolver } from "./bundle-auth"

describe("codexBundlePiBackendResolver", () => {
  test("resolves only the exact selected openai-codex model", async () => {
    const resolver = codexBundlePiBackendResolver({
      loadBundle: () => ({ access: "access", refresh: "refresh", expires: Date.now() + 60_000 }),
    })

    const backend = await resolver({
      sessionId: "session-a",
      model: { providerID: "openai-codex", modelID: "gpt-5.1-codex-mini" },
    })

    expect(backend?.model).toMatchObject({ provider: "openai-codex", id: "gpt-5.1-codex-mini" })
    expect(await resolver({
      sessionId: "session-b",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
    })).toBeUndefined()
  })
})

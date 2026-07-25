import { describe, expect, test } from "bun:test"
import { PiModelResolutionError, piApiKeyBackendResolver, requirePiModel } from "./model-backend"

describe("Pi model backend resolution", () => {
  test("resolves the exact selected model through an API-key owner", async () => {
    const loads: Array<{ sessionId: string; providerID: string }> = []
    const resolver = piApiKeyBackendResolver({
      loadApiKey: (input) => {
        loads.push(input)
        return "secret"
      },
    })

    const backend = await resolver({
      sessionId: "session-a",
      model: { providerID: "openai", modelID: "gpt-4.1" },
    })

    expect(backend?.model).toMatchObject({ provider: "openai", id: "gpt-4.1" })
    expect(loads).toEqual([{ sessionId: "session-a", providerID: "openai" }])
  })

  test("returns no backend when selection or credentials are missing", async () => {
    const resolver = piApiKeyBackendResolver({ loadApiKey: () => undefined })

    expect(await resolver({ sessionId: "session-a" })).toBeUndefined()
    expect(await resolver({
      sessionId: "session-a",
      model: { providerID: "openai", modelID: "gpt-4.1" },
    })).toBeUndefined()
  })

  test("rejects unknown models with a structured error", () => {
    // `expect.objectContaining` is not generic; the shape is pinned on the const
    // so `code` is checked against `PiModelResolutionErrorCode` rather than being
    // a free-form string the matcher would accept either way.
    const unsupportedModel: Partial<PiModelResolutionError> = { code: "unsupported_model" }
    expect(() => requirePiModel({ providerID: "openai", modelID: "not-a-model" })).toThrow(
      expect.objectContaining(unsupportedModel),
    )
  })
})

import { describe, expect, test } from "bun:test"
import { resolveDraftDefault, shouldApplyDraftDefault } from "./draft-default-policy"

describe("draft default policy", () => {
  test("restores an exact eligible saved harness/model pair", () => {
    const models = [
      { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
      { providerID: "openai", modelID: "gpt-5.4" },
      { providerID: "codex-acp", modelID: "gpt-5.5" },
      { providerID: "claude-sdk", modelID: "opus" },
    ]

    expect([
      resolveDraftDefault({
        saved: { harness: "opencode", model: models[0] },
        supportedHarnesses: ["opencode", "pi", "codex-acp", "claude-sdk"],
        eligibleModels: models,
      }),
      resolveDraftDefault({
        saved: { harness: "pi", model: models[1] },
        supportedHarnesses: ["opencode", "pi", "codex-acp", "claude-sdk"],
        eligibleModels: models,
      }),
      resolveDraftDefault({
        saved: { harness: "codex-acp", model: models[2] },
        supportedHarnesses: ["opencode", "pi", "codex-acp", "claude-sdk"],
        eligibleModels: models,
      }),
      resolveDraftDefault({
        saved: { harness: "claude-sdk", model: models[3] },
        supportedHarnesses: ["opencode", "pi", "codex-acp", "claude-sdk"],
        eligibleModels: models,
      }),
    ]).toEqual([
      { harness: "opencode", model: models[0], state: "ready", source: "saved" },
      { harness: "pi", model: models[1], state: "ready", source: "saved" },
      { harness: "codex-acp", model: models[2], state: "ready", source: "saved" },
      { harness: "claude-sdk", model: models[3], state: "ready", source: "saved" },
    ])
  })

  test("keeps a stale saved pair blocked without substituting an eligible model with the same ID", () => {
    const saved = { providerID: "openai", modelID: "gpt-5.4" }

    expect(
      resolveDraftDefault({
        saved: { harness: "pi", model: saved },
        supportedHarnesses: ["opencode", "pi"],
        eligibleModels: [{ providerID: "azure", modelID: "gpt-5.4" }],
      }),
    ).toEqual({
      harness: "pi",
      blockedModel: saved,
      state: "saved-model-unavailable",
      source: "saved",
    })
  })

  test("requires the complete saved ModelKey variant to remain eligible", () => {
    const saved = { providerID: "openai", modelID: "gpt-5.4", variant: "high" }

    expect(
      resolveDraftDefault({
        saved: { harness: "opencode", model: saved },
        supportedHarnesses: ["opencode"],
        eligibleModels: [{ providerID: "openai", modelID: "gpt-5.4" }],
      }),
    ).toEqual({
      harness: "opencode",
      blockedModel: saved,
      state: "saved-model-unavailable",
      source: "saved",
    })
  })

  test("uses an eligible declared default when the saved harness has no model", () => {
    const model = { providerID: "codex-acp", modelID: "default" }

    expect(
      resolveDraftDefault({
        saved: { harness: "codex-acp" },
        supportedHarnesses: ["opencode", "codex-acp"],
        eligibleModels: [model],
        declaredDefaultModel: model,
      }),
    ).toEqual({
      harness: "codex-acp",
      model,
      state: "ready",
      source: "harness-default",
    })
  })

  test("reuses the exact eligible OpenCode pair for Pi when Pi has no saved model", () => {
    const currentOpenCodeModel = { providerID: "openai", modelID: "gpt-5.4" }

    expect(
      resolveDraftDefault({
        saved: { harness: "pi" },
        supportedHarnesses: ["opencode", "pi"],
        eligibleModels: [currentOpenCodeModel, { providerID: "azure", modelID: "gpt-5.4" }],
        openCodeModel: currentOpenCodeModel,
      }),
    ).toEqual({
      harness: "pi",
      model: currentOpenCodeModel,
      state: "ready",
      source: "pi-opencode",
    })
  })

  test("uses the sole connected Pi provider's catalog-valid declared default", () => {
    const model = { providerID: "openai", modelID: "gpt-5.4" }

    expect(
      resolveDraftDefault({
        saved: { harness: "pi" },
        supportedHarnesses: ["opencode", "pi"],
        eligibleModels: [model],
        connectedProviderIDs: ["openai"],
        providerDefaults: { openai: "gpt-5.4" },
      }),
    ).toEqual({
      harness: "pi",
      model,
      state: "ready",
      source: "pi-provider-default",
    })
  })

  test("does not guess when Pi provider defaults are ambiguous or absent from the catalog", () => {
    const choose = { harness: "pi", state: "choose-model", source: "harness-default" }

    expect(
      resolveDraftDefault({
        saved: { harness: "pi" },
        supportedHarnesses: ["opencode", "pi"],
        eligibleModels: [
          { providerID: "openai", modelID: "gpt-5.4" },
          { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
        ],
        connectedProviderIDs: ["openai", "anthropic"],
        providerDefaults: { openai: "gpt-5.4", anthropic: "claude-sonnet-4-5" },
      }),
    ).toEqual(choose)
    expect(
      resolveDraftDefault({
        saved: { harness: "pi" },
        supportedHarnesses: ["opencode", "pi"],
        eligibleModels: [{ providerID: "openai", modelID: "gpt-5.4" }],
        connectedProviderIDs: ["openai"],
        providerDefaults: { openai: "removed-model" },
      }),
    ).toEqual(choose)
    expect(
      resolveDraftDefault({
        saved: { harness: "pi" },
        supportedHarnesses: ["opencode", "pi"],
        eligibleModels: [
          { providerID: "openai", modelID: "gpt-5.4" },
          { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
        ],
        connectedProviderIDs: ["openai", "anthropic"],
        providerDefaults: { openai: "gpt-5.4", anthropic: "claude-sonnet-4-5" },
        declaredDefaultModel: { providerID: "openai", modelID: "gpt-5.4" },
      }),
    ).toEqual(choose)
  })

  test("uses the placement-supported default without mutating the saved pair", () => {
    const saved = { harness: "pi" as const, model: { providerID: "openai", modelID: "gpt-5.4" } }
    const placementDefault = {
      harness: "opencode" as const,
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
    }

    expect(
      resolveDraftDefault({
        saved,
        supportedHarnesses: ["opencode"],
        eligibleModels: [],
        placementDefault,
      }),
    ).toEqual({
      ...placementDefault,
      state: "unsupported-placement",
      source: "placement-default",
    })
    expect(saved).toEqual({
      harness: "pi",
      model: { providerID: "openai", modelID: "gpt-5.4" },
    })
  })

  test("applies async resolution only to the captured unresolved draft revision", () => {
    const captured = { workspaceKey: "workspace-a", scope: "draft:a", revision: 4 }
    const unresolved = { ...captured, authority: "unresolved" as const }

    expect(shouldApplyDraftDefault(captured, unresolved)).toBe(true)
    expect(shouldApplyDraftDefault(captured, { ...unresolved, authority: "defaulted" })).toBe(false)
    expect(shouldApplyDraftDefault(captured, { ...unresolved, authority: "explicit" })).toBe(false)
    expect(shouldApplyDraftDefault(captured, { ...unresolved, authority: "server" })).toBe(false)
    expect(shouldApplyDraftDefault(captured, { ...unresolved, revision: 5 })).toBe(false)
    expect(shouldApplyDraftDefault(captured, { ...unresolved, workspaceKey: "workspace-b" })).toBe(false)
    expect(shouldApplyDraftDefault(captured, { ...unresolved, scope: "session:promoted" })).toBe(false)
  })
})

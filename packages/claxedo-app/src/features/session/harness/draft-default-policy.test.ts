import { describe, expect, test } from "bun:test"
import { resolveDraftDefault, shouldApplyDraftDefault } from "./draft-default-policy"

const PI = { kind: "native", harnessId: "pi" } as const
const CODEX = { kind: "native", harnessId: "codex" } as const
const CLAUDE = { kind: "native", harnessId: "claude" } as const
const TEAM_AGENT = { kind: "connection", connectionId: "team-agent" } as const
const EXTERNAL_OPENCODE = { kind: "connection", connectionId: "external-opencode" } as const

describe("draft default policy", () => {
  test("restores an exact eligible saved harness/model pair", () => {
    const models = [
      { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
      { providerID: "openai", modelID: "gpt-5.4" },
      { providerID: "codex", modelID: "gpt-5.5" },
      { providerID: "claude", modelID: "opus" },
    ]

    expect([
      resolveDraftDefault({
        saved: { harness: EXTERNAL_OPENCODE, model: models[0] },
        supportedHarnesses: [EXTERNAL_OPENCODE, PI, CODEX, CLAUDE],
        eligibleModels: models,
      }),
      resolveDraftDefault({
        saved: { harness: PI, model: models[1] },
        supportedHarnesses: [EXTERNAL_OPENCODE, PI, CODEX, CLAUDE],
        eligibleModels: models,
      }),
      resolveDraftDefault({
        saved: { harness: CODEX, model: models[2] },
        supportedHarnesses: [EXTERNAL_OPENCODE, PI, CODEX, CLAUDE],
        eligibleModels: models,
      }),
      resolveDraftDefault({
        saved: { harness: CLAUDE, model: models[3] },
        supportedHarnesses: [EXTERNAL_OPENCODE, PI, CODEX, CLAUDE],
        eligibleModels: models,
      }),
    ]).toEqual([
      { harness: EXTERNAL_OPENCODE, model: models[0], state: "ready", source: "saved" },
      { harness: PI, model: models[1], state: "ready", source: "saved" },
      { harness: CODEX, model: models[2], state: "ready", source: "saved" },
      { harness: CLAUDE, model: models[3], state: "ready", source: "saved" },
    ])
  })

  test("keeps a stale saved pair blocked without substituting an eligible model with the same ID", () => {
    const saved = { providerID: "openai", modelID: "gpt-5.4" }

    expect(resolveDraftDefault({
      saved: { harness: PI, model: saved },
      supportedHarnesses: [EXTERNAL_OPENCODE, PI],
      eligibleModels: [{ providerID: "azure", modelID: "gpt-5.4" }],
    })).toEqual({
      harness: PI,
      blockedModel: saved,
      state: "saved-model-unavailable",
      source: "saved",
    })
  })

  test("requires the complete saved ModelKey variant to remain eligible", () => {
    const saved = { providerID: "openai", modelID: "gpt-5.4", variant: "high" }

    expect(resolveDraftDefault({
      saved: { harness: EXTERNAL_OPENCODE, model: saved },
      supportedHarnesses: [EXTERNAL_OPENCODE],
      eligibleModels: [{ providerID: "openai", modelID: "gpt-5.4" }],
    })).toEqual({
      harness: EXTERNAL_OPENCODE,
      blockedModel: saved,
      state: "saved-model-unavailable",
      source: "saved",
    })
  })

  test("uses an eligible declared default when the saved harness has no model", () => {
    const model = { providerID: "codex", modelID: "default" }

    expect(resolveDraftDefault({
      saved: { harness: CODEX },
      supportedHarnesses: [EXTERNAL_OPENCODE, CODEX],
      eligibleModels: [model],
      declaredDefaultModel: model,
    })).toEqual({
      harness: CODEX,
      model,
      state: "ready",
      source: "harness-default",
    })
  })

  test("does not reuse an unrelated connection model for Pi", () => {
    const connectionModel = { providerID: "openai", modelID: "gpt-5.4" }

    expect(resolveDraftDefault({
      saved: { harness: PI },
      supportedHarnesses: [EXTERNAL_OPENCODE, PI],
      eligibleModels: [connectionModel, { providerID: "azure", modelID: "gpt-5.4" }],
    })).toEqual({
      harness: PI,
      state: "choose-model",
      source: "harness-default",
    })
  })

  test("uses Pi's native process default when it is available", () => {
    const model = { providerID: "pi", modelID: "openai/gpt-5.4" }
    expect(resolveDraftDefault({ saved: { harness: PI }, supportedHarnesses: [PI], eligibleModels: [model], declaredDefaultModel: model }))
      .toEqual({ harness: PI, model, state: "ready", source: "harness-default" })
  })

  test("does not guess a Pi default when the process did not name an eligible model", () => {
    const input = { saved: { harness: PI }, supportedHarnesses: [PI], eligibleModels: [{ providerID: "pi", modelID: "openai/gpt-5.4" }] }
    expect(resolveDraftDefault(input).state).toBe("choose-model")
    expect(resolveDraftDefault({ ...input, declaredDefaultModel: { providerID: "pi", modelID: "openai/removed" } }).state).toBe("choose-model")
  })

  test("uses the placement-supported default without mutating the saved pair", () => {
    const saved = { harness: PI, model: { providerID: "openai", modelID: "gpt-5.4" } }
    const placementDefault = { harness: TEAM_AGENT, model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" } }

    expect(resolveDraftDefault({
      saved,
      supportedHarnesses: [TEAM_AGENT],
      eligibleModels: [],
      placementDefault,
    })).toEqual({
      ...placementDefault,
      state: "unsupported-placement",
      source: "placement-default",
    })
    expect(saved).toEqual({
      harness: PI,
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

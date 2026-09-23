import { describe, expect, test } from "bun:test"
import { requireTurnEffort, thoughtLevelConfigOption } from "./sdk-model-options"

/**
 * Shapes transcribed from the Claude Agent SDK's `ModelInfo` (sdk.d.ts):
 *   supportsEffort?: boolean
 *   supportedEffortLevels?: ('low'|'medium'|'high'|'xhigh'|'max')[]
 * Both arrive from `query().supportedModels()`. Effort is a per-model capability, so the
 * option is built from the currently selected model, not from the harness.
 */
describe("thoughtLevelConfigOption", () => {
  const models = [
    { id: "opus", name: "Opus", supportsEffort: true, supportedEffortLevels: ["low", "high", "max"] },
    { id: "haiku", name: "Haiku", supportsEffort: false },
  ]

  test("builds a thought_level select from the current model's levels, current at its declared default", () => {
    expect(thoughtLevelConfigOption([{ ...models[0], defaultEffort: "high" }, models[1]], "opus")).toEqual({
      id: "effort",
      name: "Effort",
      description: "How much reasoning effort the model should use",
      category: "thought_level",
      type: "select",
      currentValue: "high",
      selectOptions: [
        { id: "low", name: "Low" },
        { id: "high", name: "High" },
        { id: "max", name: "Max" },
      ],
    })
  })

  test("is undefined for a model that does not support effort", () => {
    expect(thoughtLevelConfigOption(models, "haiku")).toBeUndefined()
  })

  test("is undefined when the model is unknown", () => {
    expect(thoughtLevelConfigOption(models, "sonnet")).toBeUndefined()
  })

  test("leaves the current level unset when the model declares no default", () => {
    expect(thoughtLevelConfigOption(models, "opus")?.currentValue).toBeUndefined()
  })
})

describe("requireTurnEffort", () => {
  const models = [
    { id: "opus", name: "Opus", supportsEffort: true, supportedEffortLevels: ["low", "high", "max"], resolvedModel: "claude-opus-5-5" },
    { id: "haiku", name: "Haiku", supportsEffort: false },
  ]
  const turn = (modelId: string | undefined, requested: string | undefined, catalog = models) =>
    () => requireTurnEffort({ harness: "Claude", models: catalog, modelId, requested })

  test("passes a level the model supports, including under its full model id", () => {
    expect(turn("opus", "high")()).toBe("high")
    expect(turn("claude-opus-5-5", "max")()).toBe("max")
  })

  test("sends nothing when nothing was requested", () => {
    expect(turn("opus", undefined)()).toBeUndefined()
    expect(turn("opus", undefined, [])()).toBeUndefined()
  })

  test("refuses rather than drops a level the model does not offer", () => {
    expect(turn("opus", "medium")).toThrow("does not run opus at effort medium; it accepts low, high, max")
    expect(turn("haiku", "high")).toThrow("it accepts no effort for that model")
    expect(turn("unknown-model", "high")).toThrow("does not run unknown-model at effort high")
  })

  test("refuses when no catalog is loaded to confirm the level", () => {
    expect(turn("opus", "high", [])).toThrow("The Claude model list is unavailable, so effort high cannot be confirmed")
  })
})

describe("thoughtLevelConfigOption — default model resolution", () => {
  const models = [
    { id: "default", name: "Default", isDefault: true, supportsEffort: true, supportedEffortLevels: ["low", "high"] },
    { id: "haiku", name: "Haiku", supportsEffort: false },
  ]

  test("uses the advertised default model when the current one is empty", () => {
    expect(thoughtLevelConfigOption(models, "")?.selectOptions).toEqual([
      { id: "low", name: "Low" },
      { id: "high", name: "High" },
    ])
  })

  test("uses the advertised default model when the current one is undefined", () => {
    expect(thoughtLevelConfigOption(models, undefined)).toBeDefined()
  })

  test("still honours an explicitly selected model over the default", () => {
    expect(thoughtLevelConfigOption(models, "haiku")).toBeUndefined()
  })
})

import { describe, expect, test } from "bun:test"
import { resolveTurnEffort, thoughtLevelConfigOption } from "./sdk-model-catalog"

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

  test("builds a thought_level select from the current model's levels", () => {
    expect(thoughtLevelConfigOption(models, "opus", "high")).toEqual({
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
    expect(thoughtLevelConfigOption(models, "haiku", "high")).toBeUndefined()
  })

  test("is undefined when the model is unknown", () => {
    expect(thoughtLevelConfigOption(models, "sonnet", undefined)).toBeUndefined()
  })

  test("leaves the current level unset when it is not offered", () => {
    expect(thoughtLevelConfigOption(models, "opus", "xhigh")?.currentValue).toBeUndefined()
  })
})

/**
 * The SDK types `effort` as a closed union and silently downgrades a level the
 * chosen model does not support. Both make a blind cast the wrong move: the
 * turn would run at a different effort than the UI reports. Resolve against the
 * model's own `supportedEffortLevels` instead, and send nothing when it does
 * not match — "unset" is a real state (the model decides).
 */
describe("resolveTurnEffort", () => {
  const models = [
    { id: "opus", name: "Opus", supportsEffort: true, supportedEffortLevels: ["low", "high", "max"] },
    { id: "haiku", name: "Haiku", supportsEffort: false },
  ]

  test("passes a level the current model supports", () => {
    expect(resolveTurnEffort(models, "opus", "high")).toBe("high")
  })

  test("drops a level the current model does not offer", () => {
    expect(resolveTurnEffort(models, "opus", "medium")).toBeUndefined()
  })

  test("drops anything for a model without effort support", () => {
    expect(resolveTurnEffort(models, "haiku", "high")).toBeUndefined()
  })

  test("drops a value that is not an SDK effort level at all", () => {
    expect(resolveTurnEffort(models, "opus", "turbo")).toBeUndefined()
  })

  test("is undefined when nothing was requested", () => {
    expect(resolveTurnEffort(models, "opus", undefined)).toBeUndefined()
  })
})

describe("thoughtLevelConfigOption — default model resolution", () => {
  const models = [
    { id: "default", name: "Default", isDefault: true, supportsEffort: true, supportedEffortLevels: ["low", "high"] },
    { id: "haiku", name: "Haiku", supportsEffort: false },
  ]

  test("uses the advertised default model when the current one is empty", () => {
    expect(thoughtLevelConfigOption(models, "", undefined)?.selectOptions).toEqual([
      { id: "low", name: "Low" },
      { id: "high", name: "High" },
    ])
  })

  test("uses the advertised default model when the current one is undefined", () => {
    expect(thoughtLevelConfigOption(models, undefined, undefined)).toBeDefined()
  })

  test("still honours an explicitly selected model over the default", () => {
    expect(thoughtLevelConfigOption(models, "haiku", undefined)).toBeUndefined()
  })
})

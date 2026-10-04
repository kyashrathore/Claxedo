import { expect, test } from "bun:test"
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk"
import { claudeCatalogModel, modelOptions, requiredClaudeEffort } from "./models"

const models = [
  { value: "haiku", displayName: "Haiku", description: "Fast", supportsEffort: false },
  { value: "default", displayName: "Default", description: "Default", supportsEffort: true, supportedEffortLevels: ["low", "high"] },
  { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus", description: "Deep",
    supportsEffort: true, supportedEffortLevels: ["high", "max"] },
] as ModelInfo[]

test("the picker is empty before the SDK supplies models and selects the actual default row", () => {
  expect(modelOptions([], "default")).toEqual([])
  expect(modelOptions(models, "default")[0]?.currentValue).toBe("default")
  expect(modelOptions(models, "default")[0]?.selectOptions?.map((row) => row.id)).toEqual(["haiku", "default", "opus"])
})

test("a saved full model id resolves its SDK alias and takes only reported effort", () => {
  expect(claudeCatalogModel(models, "claude-opus-5-5")?.value).toBe("opus")
  expect(requiredClaudeEffort(models, "claude-opus-5-5", "max")).toBe("max")
  expect(modelOptions(models, "claude-opus-5-5")[1]?.selectOptions?.map((row) => row.id)).toEqual(["high", "max"])
})

test("an alias row carries the full model id it runs, so a session on that id is current on it", () => {
  const rows = modelOptions(models, "claude-opus-5-5")[0]?.selectOptions
  expect(rows?.find((row) => row.id === "opus")).toMatchObject({ id: "opus", resolvedModel: "claude-opus-5-5" })
  expect(rows?.find((row) => row.id === "haiku")).not.toHaveProperty("resolvedModel")
})

test("an unsupported effort is refused by name", () => {
  expect(() => requiredClaudeEffort(models, "haiku", "high")).toThrow("does not run haiku at effort high")
  expect(() => requiredClaudeEffort([], "default", "high")).toThrow("does not run default at effort high")
})

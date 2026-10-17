import { expect, test } from "bun:test"
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk"
import type { DraftLaunch } from "../../contract"
import { claudeCatalogModel, claudeProbeModel, modelOptions, requiredClaudeEffort } from "./models"

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

const draft = (patch: Partial<DraftLaunch> = {}): DraftLaunch => ({
  workspaceId: "w1", directory: "/work", locality: "local", owner: { kind: "person", userId: "member" },
  config: { harness: { id: "claude", access: "native" } }, projection: { generation: "g1", mcpServers: [], pluginRoots: [], notApplied: [] },
  credentials: { machineLoginAllowed: true, accountOwner: "fixture-owner", providers: {}, secrets: {}, leaseGeneration: "lease-1" },
  ...patch,
})

test("a catalog probe for a draft that names its model asks Claude Code with that model, so the list it answers is the one that model runs from", () => {
  expect(claudeProbeModel(draft({ model: { providerID: "claude", modelID: "claude-haiku-4-5-20251001" } }))).toEqual({ model: "claude-haiku-4-5-20251001" })
  expect(claudeProbeModel(draft())).toEqual({})
})

import { describe, expect, test } from "bun:test"
import { NO_HARNESS_EFFORT } from "@claxedo/agent-runtime-contract"
import { harnessEffortLevels } from "./harness-effort"
import type { SdkModelEntry } from "./sdk-model-options"

const CATALOG: SdkModelEntry[] = [
  { id: "opus", name: "Opus", supportsEffort: true, supportedEffortLevels: ["low", "high", "max"], defaultEffort: "high" },
  { id: "haiku", name: "Haiku" },
  { id: "sonnet", name: "Sonnet", supportsEffort: true, supportedEffortLevels: ["low", "medium"], defaultEffort: "xhigh" },
]

describe("harnessEffortLevels", () => {
  test("reports one row per model that reported levels, with the harness's own default", () => {
    expect(harnessEffortLevels(CATALOG)).toEqual({
      status: "resolved",
      models: [
        { modelID: "opus", levels: ["low", "high", "max"], default: "high" },
        { modelID: "sonnet", levels: ["low", "medium"] },
      ],
    })
  })

  test("a model that declares no effort support contributes no row even with levels attached", () => {
    const levelsWithoutSupport: SdkModelEntry[] = [{ id: "m", name: "M", supportedEffortLevels: ["low"] }]
    expect(harnessEffortLevels(levelsWithoutSupport).models).toEqual([])
  })

  test("an unanswered catalog is unresolved rather than unsupported", () => {
    expect(harnessEffortLevels([])).toEqual({ status: "unresolved", models: [] })
    expect(NO_HARNESS_EFFORT).toEqual({ status: "unsupported", models: [] })
  })

  test("copies the harness's level list so a later mutation cannot rewrite the catalog", () => {
    const levels = ["low", "high"]
    const catalog = harnessEffortLevels([{ id: "m", name: "M", supportsEffort: true, supportedEffortLevels: levels }])
    levels.push("max")
    expect(catalog.models[0]?.levels).toEqual(["low", "high"])
  })
})

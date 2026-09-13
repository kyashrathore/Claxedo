import { describe, expect, test } from "bun:test"
import {
  harnessEffortRefusal,
  harnessEffortVerdict,
  NO_HARNESS_EFFORT,
  parseHarnessEffortLevels,
  type HarnessEffortLevels,
} from "./harness-effort"

const RESOLVED: HarnessEffortLevels = {
  status: "resolved",
  models: [
    { modelID: "opus", levels: ["low", "high", "max"], default: "high" },
    { modelID: "sonnet", levels: ["low", "medium"] },
  ],
}

describe("harnessEffortVerdict", () => {
  test("accepts a level the model reported and refuses one it did not", () => {
    expect(harnessEffortVerdict(RESOLVED, "opus", "max")).toBe("accepted")
    expect(harnessEffortVerdict(RESOLVED, "sonnet", "max")).toBe("refused")
  })

  test("refuses every level for a model absent from a resolved catalog", () => {
    expect(harnessEffortVerdict(RESOLVED, "haiku", "low")).toBe("refused")
    expect(harnessEffortVerdict(RESOLVED, undefined, "low")).toBe("refused")
  })

  test("asking for no effort is always accepted", () => {
    expect(harnessEffortVerdict(NO_HARNESS_EFFORT, "opus", undefined)).toBe("accepted")
    expect(harnessEffortVerdict(undefined, "opus", undefined)).toBe("accepted")
  })

  test("separates a cold catalog from a harness that takes no effort", () => {
    expect(harnessEffortVerdict({ status: "unresolved", models: [] }, "opus", "high")).toBe("unknown")
    expect(harnessEffortVerdict(undefined, "opus", "high")).toBe("unknown")
    expect(harnessEffortVerdict(NO_HARNESS_EFFORT, "opus", "high")).toBe("refused")
  })
})

describe("parseHarnessEffortLevels", () => {
  test("reads back a catalog that crossed the wire as JSON", () => {
    expect(parseHarnessEffortLevels(JSON.parse(JSON.stringify(RESOLVED)))).toEqual(RESOLVED)
  })

  test("answers undefined for anything that is not a catalog", () => {
    expect(parseHarnessEffortLevels(undefined)).toBeUndefined()
    expect(parseHarnessEffortLevels({ status: "cold", models: [] })).toBeUndefined()
    expect(parseHarnessEffortLevels("resolved")).toBeUndefined()
  })

  test("drops a row that names no model rather than inventing one", () => {
    expect(parseHarnessEffortLevels({ status: "resolved", models: [{ levels: ["low"] }, { modelID: "m" }] })).toEqual({
      status: "resolved",
      models: [{ modelID: "m", levels: [] }],
    })
  })
})

describe("harnessEffortRefusal", () => {
  test("names the levels the model does accept", () => {
    expect(harnessEffortRefusal({ harness: "claude", catalog: RESOLVED, modelID: "sonnet", effort: "max" }))
      .toBe("The claude harness does not run sonnet at effort max; it accepts low, medium")
  })

  test("says so when a model in the catalog accepts none", () => {
    const catalog: HarnessEffortLevels = { status: "resolved", models: [] }
    expect(harnessEffortRefusal({ harness: "codex", catalog, modelID: "gpt-5", effort: "high" }))
      .toBe("The codex harness does not run gpt-5 at effort high; it accepts no effort for that model")
  })

  test("admits an effort the model accepts, and any effort when none was named", () => {
    expect(harnessEffortRefusal({ harness: "claude", catalog: RESOLVED, modelID: "opus", effort: "max" })).toBeUndefined()
    expect(harnessEffortRefusal({ harness: "claude", catalog: RESOLVED, modelID: "sonnet", effort: undefined })).toBeUndefined()
  })

  test("admits on silence: an unanswered catalog, a harness publishing none, and no catalog at all", () => {
    const effort = { harness: "pi", modelID: "pi/one", effort: "high" }
    expect(harnessEffortRefusal({ ...effort, catalog: { status: "unresolved", models: [] } })).toBeUndefined()
    expect(harnessEffortRefusal({ ...effort, catalog: NO_HARNESS_EFFORT })).toBeUndefined()
    expect(harnessEffortRefusal({ ...effort, catalog: undefined })).toBeUndefined()
  })
})

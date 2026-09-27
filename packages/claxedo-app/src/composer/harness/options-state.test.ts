/// <reference types="bun" />
import { expect, test } from "bun:test"
import type { HarnessOptions } from "@/server"
import { connectionHarness, nativeHarness } from "@/lib/harness-selection"
import { applyHarnessOptionsResponse } from "./options-state"

const live = (options: Partial<HarnessOptions>): HarnessOptions => ({ source: "harness", stale: false, offersOptions: true, serviceTiers: [], ...options })
const models = { choices: [{ id: "opus", name: "Opus" }, { id: "sonnet", name: "Sonnet" }], current: "sonnet" }
const efforts = { choices: [{ id: "low", name: "Low" }, { id: "high", name: "High" }], current: "low" }
const codex = nativeHarness("codex")
const gateway = connectionHarness("gateway")

test("options state: a listed model the user holds stays, and effort keeps a level the model accepts", () => {
  const decision = applyHarnessOptionsResponse({ type: codex, selectedModel: "opus", selectedThoughtLevel: "high", payload: live({ models, thoughtLevels: efforts }) })
  expect(decision).toEqual({
    patch: { optionsSource: "harness", optionsStale: false, optionsLoading: false, thoughtLevels: efforts.choices, serviceTiers: [], selectedThoughtLevel: "high", dynamicModels: models.choices, selectedModel: "opus", configError: undefined },
  })
})

test("options state: an unlisted selection falls to the harness's current model and effort", () => {
  const { patch } = applyHarnessOptionsResponse({ type: codex, selectedModel: "gone", selectedThoughtLevel: "max", payload: live({ models, thoughtLevels: efforts }) })
  expect(patch.selectedModel).toBe("sonnet")
  expect(patch.selectedThoughtLevel).toBe("low")
})

test("options state: a held user choice the list dropped is named unavailable", () => {
  const { patch } = applyHarnessOptionsResponse({ type: codex, selectedModel: "gone", preserveSelectedModel: true, payload: live({ models }) })
  expect(patch).toMatchObject({ selectedModel: "gone", configError: "Selected model unavailable", optionsLoading: false })
})

test("options state: a stale answer with no models says so at once and waits for nothing", () => {
  const decision = applyHarnessOptionsResponse({ type: codex, payload: live({ stale: true, offersOptions: false }) })
  expect(decision).toMatchObject({ patch: { configError: "Model options unavailable", dynamicModels: [], selectedModel: "", optionsLoading: false } })
})

test("options state: a native SDK's stale catalog fails at once", () => {
  const decision = applyHarnessOptionsResponse({ type: codex, payload: live({ source: "catalog", stale: true, models }) })
  expect(decision).toMatchObject({ patch: { dynamicModels: [], selectedModel: "", configError: "Model options unavailable" } })
})

test("options state: a live connection without a model option runs on the model it names, or none", () => {
  const named = applyHarnessOptionsResponse({ type: gateway, payload: live({ resolvedModel: { id: "gw", name: "Gateway default" } }) })
  expect(named).toMatchObject({ patch: { dynamicModels: [{ id: "gw", name: "Gateway default" }], selectedModel: "gw", configError: undefined } })
  const unnamed = applyHarnessOptionsResponse({ type: gateway, payload: live({}) })
  expect(unnamed.patch).toMatchObject({ dynamicModels: [], selectedModel: "", configError: undefined })
  const silent = applyHarnessOptionsResponse({ type: gateway, payload: live({ offersOptions: false }) })
  expect(silent.patch.configError).toBe("No model options available")
})

test("options state: a session keeps its model when the catalog lists it only as an alias's resolved model", () => {
  const catalog = { choices: [{ id: "default", name: "Default (recommended)" }, { id: "haiku", name: "Haiku", resolvedModel: "claude-haiku-4-5-20251001" }], current: "default" }
  const { patch } = applyHarnessOptionsResponse({ type: nativeHarness("claude"), selectedModel: "claude-haiku-4-5-20251001", sessionModel: true, payload: live({ models: catalog }) })
  expect(patch).toMatchObject({ selectedModel: "claude-haiku-4-5-20251001", configError: undefined })
})

test("options state: a session keeps a model its catalog no longer lists, and names it unavailable", () => {
  const { patch } = applyHarnessOptionsResponse({ type: codex, selectedModel: "gone", sessionModel: true, payload: live({ models }) })
  expect(patch).toMatchObject({ selectedModel: "gone", configError: "Selected model unavailable" })
})

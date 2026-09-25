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
  const decision = applyHarnessOptionsResponse({ type: codex, selectedModel: "opus", selectedThoughtLevel: "high", payload: live({ models, thoughtLevels: efforts }), tries: 0 })
  expect(decision).toEqual({
    patch: { optionsSource: "harness", optionsStale: false, optionsLoading: false, thoughtLevels: efforts.choices, serviceTiers: [], selectedThoughtLevel: "high", dynamicModels: models.choices, selectedModel: "opus", configError: undefined },
    retry: false,
    clearTries: true,
  })
})

test("options state: an unlisted selection falls to the harness's current model and effort", () => {
  const { patch } = applyHarnessOptionsResponse({ type: codex, selectedModel: "gone", selectedThoughtLevel: "max", payload: live({ models, thoughtLevels: efforts }), tries: 0 })
  expect(patch.selectedModel).toBe("sonnet")
  expect(patch.selectedThoughtLevel).toBe("low")
})

test("options state: a held user choice the list dropped is named unavailable", () => {
  const { patch, retry } = applyHarnessOptionsResponse({ type: codex, selectedModel: "gone", preserveSelectedModel: true, payload: live({ models }), tries: 0 })
  expect(patch).toMatchObject({ selectedModel: "gone", configError: "Selected model unavailable", optionsLoading: false })
  expect(retry).toBe(false)
})

test("options state: a stale answer with no models retries until the limit, then says so", () => {
  const stale = live({ stale: true, offersOptions: false })
  expect(applyHarnessOptionsResponse({ type: codex, payload: stale, tries: 0 })).toMatchObject({ retry: true, clearTries: false, patch: { configError: "Loading model options...", dynamicModels: [] } })
  const last = applyHarnessOptionsResponse({ type: codex, payload: stale, tries: 5 })
  expect(last).toMatchObject({ retry: false, patch: { configError: "Model options unavailable", selectedModel: "", optionsLoading: false } })
})

test("options state: a native SDK's stale catalog fails at once", () => {
  const decision = applyHarnessOptionsResponse({ type: codex, payload: live({ source: "catalog", stale: true, models }), tries: 0 })
  expect(decision).toMatchObject({ retry: false, clearTries: false, patch: { dynamicModels: [], selectedModel: "", configError: "Model options unavailable" } })
})

test("options state: a live connection without a model option runs on the model it names, or none", () => {
  const named = applyHarnessOptionsResponse({ type: gateway, payload: live({ resolvedModel: { id: "gw", name: "Gateway default" } }), tries: 2 })
  expect(named).toMatchObject({ retry: false, clearTries: true, patch: { dynamicModels: [{ id: "gw", name: "Gateway default" }], selectedModel: "gw", configError: undefined } })
  const unnamed = applyHarnessOptionsResponse({ type: gateway, payload: live({}), tries: 2 })
  expect(unnamed.patch).toMatchObject({ dynamicModels: [], selectedModel: "", configError: undefined })
  const silent = applyHarnessOptionsResponse({ type: gateway, payload: live({ offersOptions: false }), tries: 0 })
  expect(silent.patch.configError).toBe("No model options available")
})

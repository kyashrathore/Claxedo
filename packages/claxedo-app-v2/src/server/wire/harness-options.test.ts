/// <reference types="bun" />
import { expect, test } from "bun:test"
import { harnessOptionsFromWire } from "./harness-options"

const model = (choices: object) => ({ id: "model", name: "Model", category: "model", type: "select", currentValue: "opus", ...choices })

test("harnessOptionsFromWire: a daemon answer keeps its source and staleness", () => {
  const options = harnessOptionsFromWire({ source: "catalog", stale: true, options: [model({ selectOptions: [{ id: "opus", name: "Opus", connected: false }] })] })
  expect(options).toEqual({
    source: "catalog",
    stale: true,
    offersOptions: true,
    models: { choices: [{ id: "opus", name: "Opus", connected: false }], current: "opus" },
    serviceTiers: [],
  })
})

test("harnessOptionsFromWire: a runtime answer that declares no freshness is live, and names its resolved model", () => {
  const options = harnessOptionsFromWire({ options: [], resolvedModel: { id: "gw", name: "Gateway default" } })
  expect(options).toEqual({ source: "harness", stale: false, offersOptions: false, serviceTiers: [], resolvedModel: { id: "gw", name: "Gateway default" } })
})

test("harnessOptionsFromWire: ACP value/name choices, effort levels, and fast tiers", () => {
  const options = harnessOptionsFromWire([
    model({ options: [{ value: "opus", name: "Opus", description: "Opus 4.8 with 1M context" }, { name: "no value" }] }),
    { id: "effort", name: "Effort", category: "thought_level", type: "select", currentValue: "high", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] },
    { id: "tier", name: "Speed", category: "service_tier", type: "select", currentValue: null, selectOptions: [{ id: "fast", name: "Fast" }] },
  ])
  expect(options.models).toEqual({ choices: [{ id: "opus", name: "Opus", description: "Opus 4.8 with 1M context" }], current: "opus" })
  expect(options.thoughtLevels).toEqual({ choices: [{ id: "low", name: "Low" }, { id: "high", name: "High" }], current: "high" })
  expect(options.serviceTiers).toEqual([{ id: "fast", name: "Fast" }])
})

test("harnessOptionsFromWire: one effort level is no choice, and an empty model list is no models", () => {
  const options = harnessOptionsFromWire({ source: "harness", stale: false, options: [
    model({ selectOptions: [] }),
    { id: "effort", name: "Effort", category: "thought_level", type: "select", currentValue: "high", selectOptions: [{ id: "high", name: "High" }] },
  ] })
  expect(options.models).toBeUndefined()
  expect(options.thoughtLevels).toBeUndefined()
})

test("harnessOptionsFromWire: an unreadable answer is empty and stale", () => {
  expect(harnessOptionsFromWire("nope")).toEqual({ source: "empty", stale: true, offersOptions: false, serviceTiers: [] })
})

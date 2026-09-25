/// <reference types="bun" />
import { expect, test } from "bun:test"
import { nativeHarness } from "@/lib/harness-selection"
import { resolveDraftDefault } from "./draft-default-policy"

const codex = nativeHarness("codex")
const opencode = nativeHarness("opencode")
const gpt = { providerId: "codex", modelId: "gpt" }
const sonnet = { providerId: "anthropic", modelId: "sonnet" }

test("draft default policy: a harness the placement cannot run falls to the placement's default", () => {
  expect(resolveDraftDefault({ saved: { harness: codex }, supportedHarnesses: [opencode], eligibleModels: [], placementDefault: { harness: opencode } }))
    .toEqual({ harness: opencode, state: "unsupported-placement", source: "placement-default" })
  expect(resolveDraftDefault({ saved: { harness: codex }, supportedHarnesses: [opencode], eligibleModels: [] }))
    .toEqual({ harness: codex, state: "unsupported-placement", source: "placement-default" })
})

test("draft default policy: a saved model opens when eligible and is named when not", () => {
  expect(resolveDraftDefault({ saved: { harness: codex, model: gpt }, supportedHarnesses: [codex], eligibleModels: [gpt] }))
    .toEqual({ harness: codex, model: gpt, state: "ready", source: "saved" })
  expect(resolveDraftDefault({ saved: { harness: codex, model: gpt }, supportedHarnesses: [codex], eligibleModels: [] }))
    .toEqual({ harness: codex, blockedModel: gpt, state: "saved-model-unavailable", source: "saved" })
})

test("draft default policy: a catalog harness takes the one connected provider's default, never the harness's", () => {
  const input = { saved: { harness: opencode }, supportedHarnesses: [opencode], eligibleModels: [sonnet, gpt], declaredDefaultModel: gpt, providerDefaults: { anthropic: "sonnet", codex: "gpt" } }
  expect(resolveDraftDefault({ ...input, connectedProviderIds: ["anthropic"] })).toEqual({ harness: opencode, model: sonnet, state: "ready", source: "catalog-provider-default" })
  expect(resolveDraftDefault({ ...input, connectedProviderIds: ["anthropic", "codex"] })).toEqual({ harness: opencode, state: "choose-model", source: "harness-default" })
})

test("draft default policy: another harness opens on its declared default when eligible", () => {
  expect(resolveDraftDefault({ saved: { harness: codex }, supportedHarnesses: [codex], eligibleModels: [gpt], declaredDefaultModel: gpt }))
    .toEqual({ harness: codex, model: gpt, state: "ready", source: "harness-default" })
  expect(resolveDraftDefault({ saved: { harness: codex }, supportedHarnesses: [codex], eligibleModels: [], declaredDefaultModel: gpt }))
    .toEqual({ harness: codex, state: "choose-model", source: "harness-default" })
})

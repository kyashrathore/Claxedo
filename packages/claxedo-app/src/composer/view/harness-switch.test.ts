/// <reference types="bun" />
import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { nativeHarness } from "@/lib/harness-selection"
import { placementId, type ModelChoice } from "@/server"
import type { HarnessSelectionController } from "../harness/controller"
import type { HarnessType } from "../harness/profile"
import { createHarnessSwitch } from "./harness-switch"
import type { SelectorCatalog } from "./selector-catalog"

const opus = { providerId: "anthropic", modelId: "claude-opus-5-5" }

function switchFor(harness: HarnessType, chosen: ModelChoice | undefined) {
  return createRoot((dispose) => {
    const calls: string[] = []
    let finishProbe = () => undefined as void
    const controller = {
      read: () => ({ selectedModelKey: chosen }),
      reprobe: (scope: string) => {
        calls.push(`reprobe ${scope}`)
        return new Promise<void>((resolve) => { finishProbe = resolve })
      },
      setModel: (scope: string, model: ModelChoice) => void calls.push(`setModel ${scope} ${model.modelId}`),
    } as unknown as HarnessSelectionController
    const catalog = {
      providers: { refresh: async () => void calls.push("refresh catalog"), error: () => undefined, default: () => ({ anthropic: opus.modelId }) },
      rows: () => ({ connected: new Set(["anthropic"]), rows: [{ id: opus.modelId, name: "Claude Opus 5.5", provider: { id: "anthropic", name: "Anthropic" }, connected: true }], eligibleModels: [opus] }),
    } as unknown as SelectorCatalog
    const scopeInput = { placementId: placementId("ws_1") }
    const harnessSwitch = createHarnessSwitch({ controller: () => controller, scope: () => "draft:1", scopeInput: () => scopeInput, harness: () => harness, polling: () => false, options: () => [harness], catalog })
    return { harnessSwitch, calls, finishProbe: () => finishProbe(), dispose }
  })
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

test("harness switch: a reread after a wake reads the harness and its catalog again as a re-pick does, choosing the catalog's default when no model is chosen", async () => {
  const view = switchFor(nativeHarness("opencode"), undefined)
  const reread = view.harnessSwitch.reread()
  expect(view.harnessSwitch.switching(), "the picker shows the models loading meanwhile").toBe(true)
  await settle()
  view.finishProbe()
  await reread
  expect(view.calls).toEqual(["reprobe draft:1", "refresh catalog", "setModel draft:1 claude-opus-5-5"])
  expect(view.harnessSwitch.switching()).toBe(false)
  view.dispose()
})

test("harness switch: a reread keeps a model already chosen and reads a sandbox harness's options alone", async () => {
  const opencode = switchFor(nativeHarness("opencode"), opus)
  const reread = opencode.harnessSwitch.reread()
  opencode.finishProbe()
  await reread
  expect(opencode.calls).toEqual(["reprobe draft:1", "refresh catalog"])
  opencode.dispose()
  const claude = switchFor(nativeHarness("claude"), undefined)
  const claudeReread = claude.harnessSwitch.reread()
  claude.finishProbe()
  await claudeReread
  expect(claude.calls).toEqual(["reprobe draft:1"])
  claude.dispose()
})

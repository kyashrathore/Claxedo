/// <reference types="bun" />
import { expect, test } from "bun:test"
import { nativeHarness } from "@/lib/harness-selection"
import { placementId } from "@/server"
import { createHarnessStore } from "./harness-store"
import { createHarnessSwitcher } from "./harness-switcher"

function memoryStorage() {
  const items = new Map<string, string>()
  return { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => void items.set(key, value) }
}

const workspace = { serverUrl: "http://127.0.0.1:4096", placementId: placementId("placement-app") }
const sonnet = { providerId: "pi", modelId: "anthropic/claude-sonnet-5-5" }

function switcherOver(store: ReturnType<typeof createHarnessStore>) {
  const fetched: Array<{ scope: string; model: string }> = []
  const pending = new Map<string, Promise<void>>()
  const switcher = createHarnessSwitcher({
    seed: store.seed,
    applyPatch: store.applyPatch,
    holdHarness: store.holdHarness,
    restoreHeldHarness: store.restoreHeldHarness,
    beginDraftHarnessChoice: (scope, type) => store.beginDraftHarnessChoice(scope, workspace, type),
    rememberDraftHarness: (scope, type) => void store.rememberDraftHarness(scope, workspace, type, true),
    fetchConfigOptions: (scope) => void fetched.push({ scope, model: store.selectedModel(scope) }),
    cache: { getPending: (key) => pending.get(key), setPending: (key, value) => void pending.set(key, value), removePending: (key) => void pending.delete(key) },
  })
  return { switcher, fetched }
}

test("switching to a harness with a chosen model selects it before that harness's options are read", async () => {
  const store = createHarnessStore(memoryStorage())
  store.applyPatch("draft:a", { harness: nativeHarness("claude"), selectedModel: "opus" })
  const { switcher, fetched } = switcherOver(store)
  await switcher.setHarness("draft:a", nativeHarness("pi"), { placementId: workspace.placementId }, sonnet)
  expect(store.harness("draft:a")).toEqual(nativeHarness("pi"))
  expect(store.selectedModelKey("draft:a")).toEqual(sonnet)
  expect(fetched).toEqual([{ scope: "draft:a", model: sonnet.modelId }])
})

test("a session switched to a harness with a chosen model holds both until the next send commits them", async () => {
  const store = createHarnessStore(memoryStorage())
  store.applyPatch("session:s", { harness: nativeHarness("claude"), selectedModel: "opus" })
  const { switcher } = switcherOver(store)
  await switcher.setHarness("session:s", nativeHarness("pi"), { placementId: workspace.placementId, sessionId: "s" }, sonnet)
  expect(store.heldHarness("session:s")).toEqual(nativeHarness("pi"))
  expect(store.selectedModelKey("session:s")).toEqual(sonnet)
})

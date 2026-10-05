/// <reference types="bun" />
import { expect, test } from "bun:test"
import { nativeHarness } from "@/lib/harness-selection"
import { placementId } from "@/server"
import { createHarnessStore } from "./harness-store"
import { rememberDraftModelInWorkspace, type HarnessWiring } from "./harness-wiring"

function memoryStorage() {
  const items = new Map<string, string>()
  return { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => void items.set(key, value) }
}

test("a draft that chose another Where saves its model as the default of the placement it opened on, not of the chosen Where", () => {
  const serverUrl = "http://127.0.0.1:4096"
  const folder = placementId("ws_folder")
  const cloud = placementId("ws_cloud")
  const storage = memoryStorage()
  const store = createHarnessStore(storage)
  const wiring = { api: { serverUrl }, store } as unknown as HarnessWiring
  store.applyPatch("draft:a", { harness: nativeHarness("claude"), dynamicModels: [{ id: "opus", name: "Opus" }] })
  expect(rememberDraftModelInWorkspace(wiring, "draft:a", { providerId: "claude", modelId: "opus" }, { placementId: cloud, draftDefaultPlacementId: folder })).toBe(true)

  const next = createHarnessStore(storage)
  expect(next.beginDraftDefault("draft:b", { serverUrl, placementId: folder })?.saved?.model).toEqual({ providerId: "claude", modelId: "opus" })
  expect(next.beginDraftDefault("draft:c", { serverUrl, placementId: cloud })?.saved).toBeUndefined()
})

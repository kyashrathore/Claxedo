/// <reference types="bun" />
import { expect, test } from "bun:test"
import { nativeHarness } from "@/lib/harness-selection"
import { placementId } from "@/server"
import { createHarnessStore } from "./harness-store"

function memoryStorage() {
  const items = new Map<string, string>()
  return { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => void items.set(key, value) }
}

const workspace = { serverUrl: "http://127.0.0.1:4096", placementId: placementId("placement-app") }
const claude = nativeHarness("claude")
const codex = nativeHarness("codex")
const opus = { providerId: "claude", modelId: "opus" }

test("harness store: a new draft opens on the workspace's remembered harness and model", () => {
  const storage = memoryStorage()
  const first = createHarnessStore(storage)
  first.beginDraftDefault("draft:a", workspace)
  first.applyPatch("draft:a", { harness: claude, dynamicModels: [{ id: "opus", name: "Opus" }] })
  expect(first.rememberDraftModel("draft:a", workspace, opus, { model: "Opus" }, true)).toBe(true)

  const next = createHarnessStore(storage)
  const begun = next.beginDraftDefault("draft:b", workspace)
  expect(begun?.saved).toEqual({ harness: claude, model: opus, labels: { model: "Opus" } })
  expect(next.harness("draft:b")).toEqual(claude)
  expect(next.selectedModel("draft:b")).toBe("opus")
  expect(next.draftDefaultAuthority("draft:b")).toBe("unresolved")
})

test("harness store: switching harness restores that harness's own model, never the one left", () => {
  const store = createHarnessStore(memoryStorage())
  store.applyPatch("draft:a", { harness: claude, dynamicModels: [{ id: "opus", name: "Opus" }] })
  store.rememberDraftModel("draft:a", workspace, opus, undefined, true)
  store.rememberDraftHarness("draft:a", workspace, claude, true)
  store.beginDraftHarnessChoice("draft:a", workspace, codex)
  expect(store.selectedModel("draft:a")).toBe("")
  expect(store.draftDefaultModel("draft:a")).toBeUndefined()
  store.beginDraftHarnessChoice("draft:a", workspace, claude)
  expect(store.selectedModel("draft:a")).toBe("opus")
  expect(store.protectDraftModel("draft:a")).toBe(true)
})

test("harness store: a model outside the harness's list is refused", () => {
  const store = createHarnessStore(memoryStorage())
  store.applyPatch("draft:a", { harness: codex, dynamicModels: [{ id: "gpt", name: "GPT" }] })
  expect(store.acceptsDraftModel("draft:a", opus)).toBe(false)
  expect(store.rememberDraftModel("draft:a", workspace, opus, undefined, true)).toBe(false)
})

test("harness store: a held pick shows the new harness and restores the session's own", () => {
  const store = createHarnessStore(memoryStorage())
  store.applyPatch("session:s", { harness: claude, selectedModel: "opus" })
  store.holdHarness("session:s", { harness: codex, selectedModel: "" })
  expect(store.heldHarness("session:s")).toEqual(codex)
  expect(store.restoreHeldHarness("session:s", codex)).toBe(false)
  expect(store.restoreHeldHarness("session:s", claude)).toBe(true)
  expect(store.harness("session:s")).toEqual(claude)
  expect(store.selectedModel("session:s")).toBe("opus")
  expect(store.heldHarness("session:s")).toBeUndefined()
})

/// <reference types="bun" />
import { describe, expect, test } from "bun:test"
import { nativeHarness } from "@/lib/harness-selection"
import { createDraftDefaultPreferences, draftDefaultStorageKey } from "./draft-defaults"

function memoryStorage() {
  const items = new Map<string, string>()
  return { items, getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => void items.set(key, value) }
}

const scope = { serverUrl: "http://127.0.0.1:4096", workspaceKey: "/work/app" }
const claude = nativeHarness("claude")

describe("draft defaults", () => {
  test("a record today's app stored reads as a model choice", () => {
    const storage = memoryStorage()
    storage.setItem(draftDefaultStorageKey(scope), JSON.stringify({
      version: 3,
      lastHarness: claude,
      byHarness: { [JSON.stringify(claude)]: { model: { providerID: "claude", modelID: "opus", variant: "high" } } },
    }))
    expect(createDraftDefaultPreferences(storage).read(scope)).toEqual({ harness: claude, model: { providerId: "claude", modelId: "opus", variant: "high" } })
  })

  test("a saved choice is stored with today's app's keys", () => {
    const storage = memoryStorage()
    expect(createDraftDefaultPreferences(storage).save(scope, { harness: claude, model: { providerId: "claude", modelId: "sonnet" } })).toBe(true)
    const stored = JSON.parse(storage.items.get(draftDefaultStorageKey(scope)) ?? "{}")
    expect(stored.byHarness[JSON.stringify(claude)]).toEqual({ model: { providerID: "claude", modelID: "sonnet" } })
  })

  test("a model from another harness's namespace is refused", () => {
    const storage = memoryStorage()
    expect(createDraftDefaultPreferences(storage).save(scope, { harness: claude, model: { providerId: "codex", modelId: "gpt" } })).toBe(false)
    expect(storage.items.size).toBe(0)
  })
})

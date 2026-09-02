import { beforeEach, describe, expect, test } from "bun:test"
import type { PanePreferenceStorage } from "@/features/session/preferences/pane"
import { createHarnessPreferences } from "./harness-preferences"

let storage: MemoryStorage

beforeEach(() => {
  storage = new MemoryStorage()
})

describe("harness preferences", () => {
  // The flat keys and the pane-scope maps are gone. They were the only path by
  // which one pane's harness choice could seed another workspace's draft, and
  // nothing writes or reads them any more.
  test("the retired flat keys and pane maps no longer seed a scope", () => {
    storage.setItem("claxedo:runner", "claude-sdk")
    storage.setItem("claxedo:acp-model", "legacy-model")
    storage.setItem("claxedo:agent-mode", "legacy-agent")
    storage.setItem("claxedo:runner-map", JSON.stringify({ "draft:/repo:route": "acp:claude" }))
    storage.setItem("claxedo:harness-map", JSON.stringify({ "draft:/repo:route": "acp:codex" }))
    storage.setItem("claxedo:acp-model-map", JSON.stringify({ "draft:/repo:route": "opus" }))
    storage.setItem("claxedo:agent-mode-map", JSON.stringify({ "draft:/repo:route": "build" }))

    for (const scope of ["draft:/repo:route", "session:ses_1"]) {
      expect(createHarnessPreferences(storage).initialState(scope)).toMatchObject({
        harness: "opencode",
        selectedModel: "",
        selectedAgent: "",
      })
    }
  })

  test("neither save nor promote writes a pane-scoped preference", () => {
    const prefs = createHarnessPreferences(storage)
    prefs.save("draft:one", "harness", "codex-app-server")
    prefs.save("draft:one", "model", "opus")
    prefs.save("draft:one", "agent", "build")
    prefs.promote("draft:one", "session:ses_1")

    for (const key of [
      "claxedo:runner",
      "claxedo:acp-model",
      "claxedo:agent-mode",
      "claxedo:runner-map",
      "claxedo:harness-map",
      "claxedo:acp-model-map",
      "claxedo:agent-mode-map",
    ]) {
      expect(storage.getItem(key)).toBeNull()
    }
  })

  test("exposes per-harness workspace defaults without writing legacy pane maps", () => {
    const preferences = createHarnessPreferences(storage)
    expect(preferences.draftDefaults.save(
      { serverUrl: "http://localhost:4096", workspaceKey: "ws_1" },
      { harness: "opencode", model: { providerID: "anthropic", modelID: "opus" } },
    )).toBe(true)

    expect(createHarnessPreferences(storage).draftDefaults.read({
      serverUrl: "http://localhost:4096",
      workspaceKey: "ws_1",
    })).toEqual({
      harness: "opencode",
      model: { providerID: "anthropic", modelID: "opus" },
    })
    expect(storage.getItem("claxedo:harness-map")).toBeNull()
    expect(storage.getItem("claxedo:acp-model-map")).toBeNull()
  })
})

class MemoryStorage implements PanePreferenceStorage {
  private values: Record<string, string> = {}

  getItem(key: string) {
    return this.values[key] ?? null
  }

  setItem(key: string, value: string) {
    this.values[key] = value
  }

  removeItem(key: string) {
    delete this.values[key]
  }
}

import { beforeEach, describe, expect, test } from "bun:test"
import type { PanePreferenceStorage } from "../../pane/store/pane-preferences"
import { createHarnessPreferences } from "./harness-preferences"

let storage: MemoryStorage

beforeEach(() => {
  storage = new MemoryStorage()
})

describe("harness preferences", () => {
  test("builds draft state from scoped preferences and ignores legacy fallbacks", () => {
    storage.setItem("claxedo:runner", "claude-acp")
    storage.setItem("claxedo:acp-model", "legacy-model")
    storage.setItem("claxedo:agent-mode", "legacy-agent")
    storage.setItem("claxedo:harness-map", JSON.stringify({ "draft:/repo:route": "codex-acp" }))
    storage.setItem("claxedo:acp-model-map", JSON.stringify({ "draft:/repo:route": "opus" }))
    storage.setItem("claxedo:agent-mode-map", JSON.stringify({ "draft:/repo:route": "build" }))

    expect(createHarnessPreferences(storage).initialState("draft:/repo:route")).toMatchObject({
      harness: "codex-acp",
      selectedModel: "opus",
      selectedAgent: "build",
    })
    expect(createHarnessPreferences(storage).initialState("draft:/new:route")).toMatchObject({
      harness: "opencode",
      selectedModel: "",
      selectedAgent: "",
    })
  })

  test("builds session state from legacy fallbacks when no scoped preferences exist", () => {
    storage.setItem("claxedo:runner", "claude-acp")
    storage.setItem("claxedo:acp-model", "legacy-model")
    storage.setItem("claxedo:agent-mode", "legacy-agent")

    expect(createHarnessPreferences(storage).initialState("session:ses_1")).toMatchObject({
      harness: "claude-acp",
      selectedModel: "legacy-model",
      selectedAgent: "legacy-agent",
    })
  })

  test("reads old pane maps but does not write or promote harness model and agent preferences", () => {
    const prefs = createHarnessPreferences(storage)
    prefs.save("draft:one", "harness", "codex-acp")
    prefs.save("draft:one", "model", "opus")
    prefs.save("draft:one", "agent", "build")
    storage.setItem("claxedo:harness-map", JSON.stringify({ "draft:one": "legacy-codex" }))
    storage.setItem("claxedo:acp-model-map", JSON.stringify({ "draft:one": "legacy-opus" }))
    storage.setItem("claxedo:agent-mode-map", JSON.stringify({ "draft:one": "legacy-build" }))

    prefs.promote("draft:one", "session:ses_1")

    expect(JSON.parse(storage.getItem("claxedo:harness-map")!)).toEqual({ "draft:one": "legacy-codex" })
    expect(JSON.parse(storage.getItem("claxedo:acp-model-map")!)).toEqual({ "draft:one": "legacy-opus" })
    expect(JSON.parse(storage.getItem("claxedo:agent-mode-map")!)).toEqual({ "draft:one": "legacy-build" })
    expect(storage.getItem("claxedo:model-variant-map")).toBeNull()
    expect(storage.getItem("claxedo:review-mode-map")).toBeNull()
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
}

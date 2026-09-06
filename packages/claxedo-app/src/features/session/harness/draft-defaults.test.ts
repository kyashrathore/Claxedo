import { beforeEach, describe, expect, test } from "bun:test"
import type { PanePreferenceStorage } from "@/features/session/preferences/pane"
import { connectionHarness, harnessSelectionKey, nativeHarness } from "@/platform/identity/harness-selection"
import {
  createDraftDefaultPreferences,
  decodeDraftDefaultRecord,
  draftDefaultStorageKey,
} from "./draft-defaults"

let storage: MemoryStorage

beforeEach(() => {
  storage = new MemoryStorage()
})

describe("workspace draft defaults", () => {
  test("round trips each harness kind with its complete model identity", () => {
    const preferences = createDraftDefaultPreferences(storage)
    const cases = [
      { harness: nativeHarness("pi"), model: { providerID: "pi", modelID: "openai-codex/gpt-5.5", variant: "high" } },
      { harness: connectionHarness("codex-team"), model: { providerID: "codex-team", modelID: "gpt-5.5" } },
      { harness: connectionHarness("external-opencode"), model: { providerID: "anthropic", modelID: "claude-opus-4" } },
    ]

    for (const [index, value] of cases.entries()) {
      expect(preferences.save({ serverUrl: "http://localhost:4096", workspaceKey: `/repo/${index}` }, value)).toBe(true)
      expect(createDraftDefaultPreferences(storage).read({
        serverUrl: "http://localhost:4096",
        workspaceKey: `/repo/${index}`,
      })).toEqual(value)
    }
  })

  test("round trips a harness without a model and bounded display hints", () => {
    const preferences = createDraftDefaultPreferences(storage)
    expect(preferences.save(
      { serverUrl: "http://localhost:4096", workspaceKey: "/repo" },
      { harness: { kind: "native", harnessId: "pi" }, labels: { provider: "OpenAI Codex", model: "GPT-5.5" } },
    )).toBe(true)

    expect(preferences.read({ serverUrl: "http://localhost:4096", workspaceKey: "/repo" })).toEqual({
      harness: nativeHarness("pi"),
      labels: { provider: "OpenAI Codex", model: "GPT-5.5" },
    })
  })

  test("isolates records by server and workspace while sharing them across owners", () => {
    const first = createDraftDefaultPreferences(storage)
    first.save(
      { serverUrl: "http://localhost:4096", workspaceKey: "ws_a" },
      { harness: { kind: "native", harnessId: "pi" }, model: { providerID: "pi", modelID: "openai/gpt-5.5" } },
    )
    first.save(
      { serverUrl: "http://localhost:4096", workspaceKey: "ws_b" },
      { harness: { kind: "connection", connectionId: "external-opencode" }, model: { providerID: "anthropic", modelID: "opus" } },
    )

    const second = createDraftDefaultPreferences(storage)
    expect(second.read({ serverUrl: "http://localhost:4096", workspaceKey: "ws_a" })?.harness).toEqual({ kind: "native", harnessId: "pi" })
    expect(second.read({ serverUrl: "http://localhost:4096", workspaceKey: "ws_b" })?.harness).toEqual({ kind: "connection", connectionId: "external-opencode" })
    expect(second.read({ serverUrl: "https://remote.example", workspaceKey: "ws_a" })).toBeUndefined()
  })

  test("promotes a directory fallback only after the canonical write succeeds", () => {
    const preferences = createDraftDefaultPreferences(storage)
    preferences.save(
      { serverUrl: "http://localhost:4096", workspaceKey: "/repo" },
      { harness: { kind: "native", harnessId: "pi" }, model: { providerID: "pi", modelID: "openai/gpt-5.5" } },
    )

    const value = preferences.read({
      serverUrl: "http://localhost:4096",
      workspaceKey: "ws_1",
      fallbackWorkspaceKey: "/repo",
    })
    expect(value?.model).toEqual({ providerID: "pi", modelID: "openai/gpt-5.5" })
    expect(storage.getItem(draftDefaultStorageKey({ serverUrl: "http://localhost:4096", workspaceKey: "/repo" }))).toBeNull()
    expect(createDraftDefaultPreferences(storage).read({ serverUrl: "http://localhost:4096", workspaceKey: "ws_1" })).toEqual(value)
  })

  test("canonical record wins over a stale directory fallback", () => {
    const preferences = createDraftDefaultPreferences(storage)
    preferences.save(
      { serverUrl: "http://localhost:4096", workspaceKey: "/repo" },
      { harness: { kind: "native", harnessId: "pi" }, model: { providerID: "pi", modelID: "openai/old" } },
    )
    preferences.save(
      { serverUrl: "http://localhost:4096", workspaceKey: "ws_1" },
      { harness: { kind: "connection", connectionId: "external-opencode" }, model: { providerID: "anthropic", modelID: "current" } },
    )

    expect(preferences.read({
      serverUrl: "http://localhost:4096",
      workspaceKey: "ws_1",
      fallbackWorkspaceKey: "/repo",
    })?.model?.modelID).toBe("current")
  })

  test("keeps the fallback readable when canonical promotion fails", () => {
    const preferences = createDraftDefaultPreferences(storage)
    preferences.save(
      { serverUrl: "http://localhost:4096", workspaceKey: "/repo" },
      { harness: { kind: "native", harnessId: "pi" }, model: { providerID: "pi", modelID: "openai/gpt-5.5" } },
    )
    storage.failWrites = true

    expect(preferences.read({
      serverUrl: "http://localhost:4096",
      workspaceKey: "ws_1",
      fallbackWorkspaceKey: "/repo",
    })?.harness).toEqual({ kind: "native", harnessId: "pi" })
    storage.failWrites = false
    expect(preferences.read({ serverUrl: "http://localhost:4096", workspaceKey: "/repo" })?.harness).toEqual({ kind: "native", harnessId: "pi" })
  })

  test("ignores malformed records and invalid current-schema harness identity", () => {
    for (const value of ["{", "[]", JSON.stringify({ version: 3, byHarness: {}, lastHarness: "pi" })]) {
      expect(decodeDraftDefaultRecord(value)).toBeUndefined()
    }
  })

  test("rejects invalid model identities and display hints inside current-schema records", () => {
    const harness = nativeHarness("pi")
    const key = harnessSelectionKey(harness)
    const other = connectionHarness("team")
    const otherKey = harnessSelectionKey(other)
    const preserved = { model: { providerID: "provider", modelID: "valid" } }
    const invalid = [
      "{",
      "[]",
      JSON.stringify({ version: 3, byHarness: {}, lastHarness: "pi" }),
      JSON.stringify({ version: 2, byHarness: {}, lastHarness: "unknown" }),
      JSON.stringify({ version: 1, harness: "unknown" }),
      JSON.stringify({ version: 1, harness: "pi", model: { providerID: "openai" } }),
      JSON.stringify({ version: 1, harness: "pi", model: { providerID: " ", modelID: "gpt" } }),
      JSON.stringify({ version: 1, harness: "pi", model: { providerID: " openai", modelID: "gpt" } }),
      JSON.stringify({ version: 1, harness: "codex-app-server", model: { providerID: "pi", modelID: "openai/gpt" } }),
      JSON.stringify({ version: 1, harness: "pi", labels: { model: "x".repeat(121) } }),
    ]

    for (const choice of invalid) {
      expect(decodeDraftDefaultRecord(JSON.stringify({
        version: 3,
        lastHarness: harness,
        byHarness: { [key]: choice, [otherKey]: preserved },
      }))).toEqual({ version: 3, lastHarness: harness, byHarness: { [otherKey]: preserved } })
    }
  })

  // The whole point of D1: two harnesses in one workspace do not share a slot.
  test("keeps each harness's own model and opens on the one last used", () => {
    const preferences = createDraftDefaultPreferences(storage)
    const scope = { serverUrl: "http://localhost:4096", workspaceKey: "/repo" }
    preferences.save(scope, { harness: nativeHarness("pi"), model: { providerID: "pi", modelID: "openai/gpt-5.5" } })
    preferences.save(scope, { harness: connectionHarness("claude-team"), model: { providerID: "claude-team", modelID: "opus" } })

    expect(preferences.read(scope)).toEqual({
      harness: connectionHarness("claude-team"),
      model: { providerID: "claude-team", modelID: "opus" },
    })
    expect(preferences.readHarness(scope, nativeHarness("pi"))).toEqual({ model: { providerID: "pi", modelID: "openai/gpt-5.5" } })
    expect(preferences.readHarness(scope, connectionHarness("claude-team"))).toEqual({ model: { providerID: "claude-team", modelID: "opus" } })
    expect(preferences.readHarness(scope, connectionHarness("external-opencode"))).toBeUndefined()

    // Switching back does not disturb the harness left behind.
    preferences.save(scope, { harness: nativeHarness("pi"), model: { providerID: "pi", modelID: "openai/gpt-5.5" } })
    expect(preferences.read(scope)?.harness).toEqual(nativeHarness("pi"))
    expect(preferences.readHarness(scope, connectionHarness("claude-team"))?.model?.modelID).toBe("opus")
  })

  test("does not import legacy string-identity records", () => {
    const scope = { serverUrl: "http://localhost:4096", workspaceKey: "/repo" }
    const key = draftDefaultStorageKey(scope)
    for (const version of [1, 2]) {
      const legacy = JSON.stringify({ version, harness: "opencode", lastHarness: "opencode", byHarness: {} })
      storage.setItem(key, legacy)
      expect(createDraftDefaultPreferences(storage).read(scope)).toBeUndefined()
      expect(storage.getItem(key)).toBe(legacy)
    }
  })

  test("isolates a native harness from a connection with the same id", () => {
    const scope = { serverUrl: "http://localhost:4096", workspaceKey: "/repo" }
    const preferences = createDraftDefaultPreferences(storage)
    preferences.save(scope, { harness: nativeHarness("claude"), model: { providerID: "claude", modelID: "sonnet" } })
    preferences.save(scope, { harness: connectionHarness("claude"), model: { providerID: "anthropic", modelID: "opus" } })
    expect(preferences.readHarness(scope, nativeHarness("claude"))?.model?.modelID).toBe("sonnet")
    expect(preferences.readHarness(scope, connectionHarness("claude"))?.model?.modelID).toBe("opus")
  })

  test("swallows storage failures", () => {
    storage.failReads = true
    expect(createDraftDefaultPreferences(storage).read({ serverUrl: "http://localhost:4096", workspaceKey: "/repo" })).toBeUndefined()
    storage.failReads = false
    storage.failWrites = true
    expect(createDraftDefaultPreferences(storage).save(
      { serverUrl: "http://localhost:4096", workspaceKey: "/repo" },
      { harness: { kind: "connection", connectionId: "external-opencode" } },
    )).toBe(false)
  })
})

class MemoryStorage implements PanePreferenceStorage {
  private values = new Map<string, string>()
  failReads = false
  failWrites = false

  getItem(key: string) {
    if (this.failReads) throw new Error("read failed")
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string) {
    if (this.failWrites) throw new Error("write failed")
    this.values.set(key, value)
  }

  removeItem(key: string) {
    this.values.delete(key)
  }
}

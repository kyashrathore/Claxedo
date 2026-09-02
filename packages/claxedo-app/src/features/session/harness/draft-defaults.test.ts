import { beforeEach, describe, expect, test } from "bun:test"
import type { PanePreferenceStorage } from "@/features/session/preferences/pane"
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
      { harness: "pi" as const, model: { providerID: "openai-codex", modelID: "gpt-5.5", variant: "high" } },
      { harness: "acp:codex" as const, model: { providerID: "acp:codex", modelID: "gpt-5.5" } },
      { harness: "opencode" as const, model: { providerID: "anthropic", modelID: "claude-opus-4" } },
    ]

    for (const value of cases) {
      expect(preferences.save({ serverUrl: "http://localhost:4096", workspaceKey: `/repo/${value.harness}` }, value)).toBe(true)
      expect(createDraftDefaultPreferences(storage).read({
        serverUrl: "http://localhost:4096",
        workspaceKey: `/repo/${value.harness}`,
      })).toEqual(value)
    }
  })

  test("round trips a harness without a model and bounded display hints", () => {
    const preferences = createDraftDefaultPreferences(storage)
    expect(preferences.save(
      { serverUrl: "http://localhost:4096", workspaceKey: "/repo" },
      { harness: "pi", labels: { provider: "OpenAI Codex", model: "GPT-5.5" } },
    )).toBe(true)

    expect(preferences.read({ serverUrl: "http://localhost:4096", workspaceKey: "/repo" })).toEqual({
      harness: "pi",
      labels: { provider: "OpenAI Codex", model: "GPT-5.5" },
    })
  })

  test("isolates records by server and workspace while sharing them across owners", () => {
    const first = createDraftDefaultPreferences(storage)
    first.save(
      { serverUrl: "http://localhost:4096", workspaceKey: "ws_a" },
      { harness: "pi", model: { providerID: "openai", modelID: "gpt-5.5" } },
    )
    first.save(
      { serverUrl: "http://localhost:4096", workspaceKey: "ws_b" },
      { harness: "opencode", model: { providerID: "anthropic", modelID: "opus" } },
    )

    const second = createDraftDefaultPreferences(storage)
    expect(second.read({ serverUrl: "http://localhost:4096", workspaceKey: "ws_a" })?.harness).toBe("pi")
    expect(second.read({ serverUrl: "http://localhost:4096", workspaceKey: "ws_b" })?.harness).toBe("opencode")
    expect(second.read({ serverUrl: "https://remote.example", workspaceKey: "ws_a" })).toBeUndefined()
  })

  test("promotes a directory fallback only after the canonical write succeeds", () => {
    const preferences = createDraftDefaultPreferences(storage)
    preferences.save(
      { serverUrl: "http://localhost:4096", workspaceKey: "/repo" },
      { harness: "pi", model: { providerID: "openai", modelID: "gpt-5.5" } },
    )

    const value = preferences.read({
      serverUrl: "http://localhost:4096",
      workspaceKey: "ws_1",
      fallbackWorkspaceKey: "/repo",
    })
    expect(value?.model).toEqual({ providerID: "openai", modelID: "gpt-5.5" })
    expect(storage.getItem(draftDefaultStorageKey({ serverUrl: "http://localhost:4096", workspaceKey: "/repo" }))).toBeNull()
    expect(createDraftDefaultPreferences(storage).read({ serverUrl: "http://localhost:4096", workspaceKey: "ws_1" })).toEqual(value)
  })

  test("canonical record wins over a stale directory fallback", () => {
    const preferences = createDraftDefaultPreferences(storage)
    preferences.save(
      { serverUrl: "http://localhost:4096", workspaceKey: "/repo" },
      { harness: "pi", model: { providerID: "openai", modelID: "old" } },
    )
    preferences.save(
      { serverUrl: "http://localhost:4096", workspaceKey: "ws_1" },
      { harness: "opencode", model: { providerID: "anthropic", modelID: "current" } },
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
      { harness: "pi", model: { providerID: "openai", modelID: "gpt-5.5" } },
    )
    storage.failWrites = true

    expect(preferences.read({
      serverUrl: "http://localhost:4096",
      workspaceKey: "ws_1",
      fallbackWorkspaceKey: "/repo",
    })?.harness).toBe("pi")
    storage.failWrites = false
    expect(preferences.read({ serverUrl: "http://localhost:4096", workspaceKey: "/repo" })?.harness).toBe("pi")
  })

  test("ignores malformed and structurally invalid records", () => {
    const invalid = [
      "{",
      "[]",
      JSON.stringify({ version: 3, byHarness: {}, lastHarness: "pi" }),
      JSON.stringify({ version: 2, byHarness: {}, lastHarness: "unknown" }),
      JSON.stringify({ version: 1, harness: "unknown" }),
      JSON.stringify({ version: 1, harness: "pi", model: { providerID: "openai" } }),
      JSON.stringify({ version: 1, harness: "pi", model: { providerID: " ", modelID: "gpt" } }),
      JSON.stringify({ version: 1, harness: "pi", model: { providerID: " openai", modelID: "gpt" } }),
      JSON.stringify({ version: 1, harness: "codex-app-server", model: { providerID: "openai", modelID: "gpt" } }),
      JSON.stringify({ version: 1, harness: "pi", labels: { model: "x".repeat(121) } }),
    ]

    for (const value of invalid) expect(decodeDraftDefaultRecord(value)).toBeUndefined()
  })

  // The whole point of D1: two harnesses in one workspace do not share a slot.
  test("keeps each harness's own model and opens on the one last used", () => {
    const preferences = createDraftDefaultPreferences(storage)
    const scope = { serverUrl: "http://localhost:4096", workspaceKey: "/repo" }
    preferences.save(scope, { harness: "pi", model: { providerID: "openai", modelID: "gpt-5.5" } })
    preferences.save(scope, { harness: "acp:claude", model: { providerID: "acp:claude", modelID: "opus" } })

    expect(preferences.read(scope)).toEqual({
      harness: "acp:claude",
      model: { providerID: "acp:claude", modelID: "opus" },
    })
    expect(preferences.readHarness(scope, "pi")).toEqual({ model: { providerID: "openai", modelID: "gpt-5.5" } })
    expect(preferences.readHarness(scope, "acp:claude")).toEqual({ model: { providerID: "acp:claude", modelID: "opus" } })
    expect(preferences.readHarness(scope, "opencode")).toBeUndefined()

    // Switching back does not disturb the harness left behind.
    preferences.save(scope, { harness: "pi", model: { providerID: "openai", modelID: "gpt-5.5" } })
    expect(preferences.read(scope)?.harness).toBe("pi")
    expect(preferences.readHarness(scope, "acp:claude")?.model?.modelID).toBe("opus")
  })

  test("upgrades a v1 single-slot record once, in the read path, and writes it back", () => {
    const key = draftDefaultStorageKey({ serverUrl: "http://localhost:4096", workspaceKey: "/repo" })
    storage.setItem(key, JSON.stringify({
      version: 1,
      harness: "acp:codex",
      model: { providerID: "acp:codex", modelID: "gpt-5.5" },
      labels: { provider: "Codex", model: "GPT-5.5" },
    }))

    const preferences = createDraftDefaultPreferences(storage)
    expect(preferences.read({ serverUrl: "http://localhost:4096", workspaceKey: "/repo" })).toEqual({
      harness: "acp:codex",
      model: { providerID: "acp:codex", modelID: "gpt-5.5" },
      labels: { provider: "Codex", model: "GPT-5.5" },
    })

    // The upgrade is persisted, so no reader below `decodeDraftDefaultRecord`
    // ever meets v1 again.
    expect(JSON.parse(storage.getItem(key)!)).toEqual({
      version: 2,
      byHarness: {
        "acp:codex": {
          model: { providerID: "acp:codex", modelID: "gpt-5.5" },
          labels: { provider: "Codex", model: "GPT-5.5" },
        },
      },
      lastHarness: "acp:codex",
    })

    // ...and the upgraded record keeps room for the other harnesses.
    preferences.save({ serverUrl: "http://localhost:4096", workspaceKey: "/repo" }, {
      harness: "opencode",
      model: { providerID: "anthropic", modelID: "opus" },
    })
    expect(preferences.readHarness({ serverUrl: "http://localhost:4096", workspaceKey: "/repo" }, "acp:codex")?.model?.modelID)
      .toBe("gpt-5.5")
  })

  test("swallows storage failures", () => {
    storage.failReads = true
    expect(createDraftDefaultPreferences(storage).read({ serverUrl: "http://localhost:4096", workspaceKey: "/repo" })).toBeUndefined()
    storage.failReads = false
    storage.failWrites = true
    expect(createDraftDefaultPreferences(storage).save(
      { serverUrl: "http://localhost:4096", workspaceKey: "/repo" },
      { harness: "opencode" },
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

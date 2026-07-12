import { beforeEach, describe, expect, test } from "bun:test"
import type { PanePreferenceStorage } from "@/features/session/preferences/pane"
import {
  createDraftDefaultPreferences,
  decodeDraftDefault,
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
      { harness: "codex-acp" as const, model: { providerID: "codex-acp", modelID: "gpt-5.5" } },
      { harness: "opencode" as const, model: { providerID: "anthropic", modelID: "claude-opus-4" } },
    ]

    for (const value of cases) {
      expect(preferences.save({ serverUrl: "http://localhost:4096", workspaceKey: `/repo/${value.harness}` }, value)).toBe(true)
      expect(createDraftDefaultPreferences(storage).read({
        serverUrl: "http://localhost:4096",
        workspaceKey: `/repo/${value.harness}`,
      })).toEqual({ version: 1, ...value })
    }
  })

  test("round trips a harness without a model and bounded display hints", () => {
    const preferences = createDraftDefaultPreferences(storage)
    expect(preferences.save(
      { serverUrl: "http://localhost:4096", workspaceKey: "/repo" },
      { harness: "pi", labels: { provider: "OpenAI Codex", model: "GPT-5.5" } },
    )).toBe(true)

    expect(preferences.read({ serverUrl: "http://localhost:4096", workspaceKey: "/repo" })).toEqual({
      version: 1,
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
      JSON.stringify({ version: 2, harness: "pi" }),
      JSON.stringify({ version: 1, harness: "unknown" }),
      JSON.stringify({ version: 1, harness: "pi", model: { providerID: "openai" } }),
      JSON.stringify({ version: 1, harness: "pi", model: { providerID: " ", modelID: "gpt" } }),
      JSON.stringify({ version: 1, harness: "pi", model: { providerID: " openai", modelID: "gpt" } }),
      JSON.stringify({ version: 1, harness: "codex-acp", model: { providerID: "openai", modelID: "gpt" } }),
      JSON.stringify({ version: 1, harness: "pi", labels: { model: "x".repeat(121) } }),
    ]

    for (const value of invalid) expect(decodeDraftDefault(value)).toBeUndefined()
  })

  test("replaces the atomic pair instead of retaining the previous harness model", () => {
    const preferences = createDraftDefaultPreferences(storage)
    const scope = { serverUrl: "http://localhost:4096", workspaceKey: "/repo" }
    preferences.save(scope, { harness: "pi", model: { providerID: "openai", modelID: "gpt-5.5" } })
    preferences.save(scope, { harness: "claude-acp", model: { providerID: "claude-acp", modelID: "opus" } })

    expect(preferences.read(scope)).toEqual({
      version: 1,
      harness: "claude-acp",
      model: { providerID: "claude-acp", modelID: "opus" },
    })
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

import { describe, expect, test } from "bun:test"
import { restoreOpenCodeDraftDefault, writeOpenCodeDraftModel, writeOpenCodeDraftVariant } from "./open-code-draft-default"
import { createHarnessStore } from "@/features/session/harness/harness-store"
import type { PanePreferenceStorage } from "@/features/session/preferences/pane"
import type { ModelKey } from "./model-strategy"

function memoryStorage(): PanePreferenceStorage {
  const entries = new Map<string, string>()
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => void entries.set(key, value),
  }
}

/** The controller binding `harness-config-store.ts` hands the composer. */
function storeController(store: ReturnType<typeof createHarnessStore>) {
  return {
    read: (scope: string) => ({
      harness: store.harness(scope),
      draftDefaultState: store.draftDefaultState(scope),
      draftDefaultModel: store.draftDefaultModel(scope),
    }),
    rememberDraftModel: () => undefined,
    resolveDraftDefault: (scope: string, input: Parameters<typeof store.applyDraftDefault>[1]) => {
      const application = store.draftDefaultApplication(scope, "opencode")
      if (!application) return false
      return store.applyDraftDefault(application, input)
    },
  }
}

function controller(input?: { state?: "ready"; model?: ModelKey }) {
  const calls: unknown[] = []
  const value = {
    read: () => ({ harness: "opencode", draftDefaultState: input?.state, draftDefaultModel: input?.model }),
    rememberDraftModel: (...args: unknown[]) => calls.push(["remember", ...args]),
    resolveDraftDefault: (...args: unknown[]) => {
      calls.push(["resolve", ...args])
      return true
    },
  }
  return { calls, value }
}

describe("OpenCode workspace draft defaults", () => {
  test("writes the selected OpenCode pair only for a new OpenCode draft", () => {
    const owner = controller()
    const writes: unknown[] = []
    writeOpenCodeDraftModel({
      controller: owner.value,
      scope: "draft:1",
      directory: "/repo",
      sessionId: "new",
      newSession: true,
      model: { providerID: "openai", modelID: "gpt-5.5" },
      write: (...args) => writes.push(args),
    })

    expect(writes).toEqual([[{ providerID: "openai", modelID: "gpt-5.5" }, undefined]])
    expect(owner.calls).toEqual([["remember", "draft:1", { providerID: "openai", modelID: "gpt-5.5" }, {
      directory: "/repo",
      sessionId: "new",
    }]])
  })

  test("restores and validates the exact saved OpenCode pair", () => {
    const model = { providerID: "openai", modelID: "gpt-5.5" }
    const owner = controller({ model })
    const writes: unknown[] = []
    expect(restoreOpenCodeDraftDefault({
      controller: owner.value,
      scope: "draft:1",
      directory: "/repo",
      sessionId: "new",
      newSession: true,
      ready: true,
      models: [{ id: "gpt-5.5", provider: { id: "openai" } }],
      write: (value) => writes.push(value),
      writeVariant: (value) => writes.push(["variant", value]),
    })).toBe(true)

    expect(writes).toEqual([model, ["variant", undefined]])
    expect(owner.calls).toEqual([["resolve", "draft:1", {
      supportedHarnesses: ["opencode"],
      eligibleModels: [model],
    }]])
  })

  test("remembers an explicit OpenCode pick even outside the new-session variant", () => {
    const owner = controller()
    const writes: unknown[] = []
    writeOpenCodeDraftModel({
      controller: owner.value,
      scope: "draft:1",
      directory: "/repo",
      sessionId: "new",
      newSession: false,
      model: { providerID: "opencode", modelID: "hy3-free" },
      write: (...args) => writes.push(args),
      labels: { provider: "OpenCode", model: "HY3 Free" },
    })

    expect(writes).toEqual([[{ providerID: "opencode", modelID: "hy3-free" }, undefined]])
    expect(owner.calls).toEqual([["remember", "draft:1", { providerID: "opencode", modelID: "hy3-free" }, {
      directory: "/repo",
      sessionId: "new",
    }, { provider: "OpenCode", model: "HY3 Free" }]])
  })

  test("does not write the saved model after draft ownership changes", () => {
    const model = { providerID: "openai", modelID: "gpt-5.5" }
    const owner = controller({ model })
    owner.value.resolveDraftDefault = (...args: unknown[]) => {
      owner.calls.push(["resolve", ...args])
      return false
    }
    const writes: unknown[] = []

    expect(restoreOpenCodeDraftDefault({
      controller: owner.value,
      scope: "draft:1",
      directory: "/repo",
      sessionId: "new",
      newSession: true,
      ready: true,
      models: [{ id: "gpt-5.5", provider: { id: "openai" } }],
      write: (value) => writes.push(value),
      writeVariant: (value) => writes.push(["variant", value]),
    })).toBe(false)

    expect(writes).toEqual([])
  })

  test("restores and persists an exact OpenCode model variant", () => {
    const model = { providerID: "openai", modelID: "gpt-5.5", variant: "high" }
    const owner = controller({ model })
    const writes: unknown[] = []

    expect(restoreOpenCodeDraftDefault({
      controller: owner.value,
      scope: "draft:1",
      directory: "/repo",
      sessionId: "new",
      newSession: true,
      ready: true,
      models: [{ id: "gpt-5.5", variants: { high: {} }, provider: { id: "openai" } }],
      write: (value) => writes.push(value),
      writeVariant: (value) => writes.push(["variant", value]),
    })).toBe(true)
    expect(writes).toEqual([model, ["variant", "high"]])

    writeOpenCodeDraftVariant({
      controller: owner.value,
      scope: "draft:1",
      directory: "/repo",
      sessionId: "new",
      newSession: true,
      model,
      variant: "low",
      write: () => writes.push("changed"),
    })
    expect(owner.calls.at(-1)).toEqual([
      "remember",
      "draft:1",
      { providerID: "openai", modelID: "gpt-5.5", variant: "low" },
      { directory: "/repo", sessionId: "new" },
      undefined,
    ])
  })

  /**
   * OpenCode has no `harness-config-options` surface — the workspace runtime and
   * the daemon both answer that route 404 for it — so the model it resolves for
   * itself is the connected provider catalog's own default. A workspace that
   * remembers nothing opens on that, instead of on "Select model".
   *
   * Driven through the REAL `createHarnessStore`, bound exactly the way
   * `harness-config-store.ts` binds this controller. A hand-written double
   * answered `draftDefaultState: undefined` and `resolveDraftDefault: true` for
   * this case; the real store answers `"ready"` and `false` — it settles a
   * no-memory scope the moment it reads one — and a fresh profile sat on
   * "Select model" while this test stayed green.
   */
  test("opens a workspace that remembers nothing on the model OpenCode resolved", () => {
    const store = createHarnessStore(memoryStorage())
    const scope = "draft:1"
    store.beginDraftDefault(scope, { serverUrl: "http://server", workspaceKey: "ws-1" })
    expect(
      store.draftDefaultState(scope),
      "the store no longer settles a no-memory scope — re-check which route this default takes",
    ).toBe("ready")

    const writes: unknown[] = []
    expect(restoreOpenCodeDraftDefault({
      controller: storeController(store),
      scope,
      directory: "/repo",
      sessionId: "new",
      newSession: true,
      ready: true,
      models: [{ id: "gpt-5.5", provider: { id: "openai" } }],
      resolvedDefault: { providerID: "openai", modelID: "gpt-5.5" },
      write: (value) => writes.push(value),
      writeVariant: (value) => writes.push(["variant", value]),
    })).toBe(true)

    expect(writes).toEqual([{ providerID: "openai", modelID: "gpt-5.5" }, ["variant", undefined]])
  })

  test("a workspace that remembers nothing never shows a resolved default the catalog dropped", () => {
    const store = createHarnessStore(memoryStorage())
    const scope = "draft:1"
    store.beginDraftDefault(scope, { serverUrl: "http://server", workspaceKey: "ws-1" })

    const writes: unknown[] = []
    expect(restoreOpenCodeDraftDefault({
      controller: storeController(store),
      scope,
      directory: "/repo",
      sessionId: "new",
      newSession: true,
      ready: true,
      models: [{ id: "gpt-5.5", provider: { id: "openai" } }],
      resolvedDefault: { providerID: "anthropic", modelID: "claude-sonnet-5" },
      write: (value) => writes.push(value),
      writeVariant: (value) => writes.push(["variant", value]),
    })).toBe(false)

    expect(writes).toEqual([])
  })

  test("an explicit pick in a workspace that remembered nothing is not overwritten by the resolved default", () => {
    const store = createHarnessStore(memoryStorage())
    const scope = "draft:1"
    const identity = { serverUrl: "http://server", workspaceKey: "ws-1" }
    store.beginDraftDefault(scope, identity)
    store.rememberDraftModel(scope, identity, { providerID: "anthropic", modelID: "claude-sonnet-5" })

    const writes: unknown[] = []
    restoreOpenCodeDraftDefault({
      controller: storeController(store),
      scope,
      directory: "/repo",
      sessionId: "new",
      newSession: true,
      ready: true,
      models: [
        { id: "claude-sonnet-5", provider: { id: "anthropic" } },
        { id: "gpt-5.5", provider: { id: "openai" } },
      ],
      resolvedDefault: { providerID: "openai", modelID: "gpt-5.5" },
      write: (value) => writes.push(value),
      writeVariant: (value) => writes.push(["variant", value]),
    })

    expect(writes).toEqual([])
  })

  test("a remembered OpenCode model outranks the resolved default", () => {
    const model = { providerID: "anthropic", modelID: "claude-sonnet-5" }
    const owner = controller({ model })
    const writes: unknown[] = []

    expect(restoreOpenCodeDraftDefault({
      controller: owner.value,
      scope: "draft:1",
      directory: "/repo",
      sessionId: "new",
      newSession: true,
      ready: true,
      models: [
        { id: "claude-sonnet-5", provider: { id: "anthropic" } },
        { id: "gpt-5.5", provider: { id: "openai" } },
      ],
      resolvedDefault: { providerID: "openai", modelID: "gpt-5.5" },
      write: (value) => writes.push(value),
      writeVariant: (value) => writes.push(["variant", value]),
    })).toBe(true)

    expect(writes).toEqual([model, ["variant", undefined]])
  })

  test("a machine with no connected provider writes nothing rather than guessing", () => {
    const owner = controller()
    const writes: unknown[] = []

    expect(restoreOpenCodeDraftDefault({
      controller: owner.value,
      scope: "draft:1",
      directory: "/repo",
      sessionId: "new",
      newSession: true,
      ready: true,
      models: [],
      write: (value) => writes.push(value),
      writeVariant: (value) => writes.push(["variant", value]),
    })).toBe(false)

    expect(writes).toEqual([])
    expect(owner.calls).toEqual([])
  })
})

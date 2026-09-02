import { describe, expect, test } from "bun:test"
import { restoreOpenCodeDraftDefault, writeOpenCodeDraftModel, writeOpenCodeDraftVariant } from "./open-code-draft-default"
import type { ModelKey } from "./model-strategy"

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
   */
  test("opens a workspace that remembers nothing on the model OpenCode resolved", () => {
    const owner = controller()
    const writes: unknown[] = []

    expect(restoreOpenCodeDraftDefault({
      controller: owner.value,
      scope: "draft:1",
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
    expect(owner.calls).toEqual([["resolve", "draft:1", {
      supportedHarnesses: ["opencode"],
      eligibleModels: [{ providerID: "openai", modelID: "gpt-5.5" }],
      declaredDefaultModel: { providerID: "openai", modelID: "gpt-5.5" },
    }]])
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

import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import type { ModelChoice } from "@/server"
import { createModelPickerState } from "./harness-model-pick"

test("model picker ignores absent, unlisted and unchanged picks, opens providers for disconnected picks, and deduplicates until a write settles", async () => {
  await createRoot(async (dispose) => {
    const pending = Promise.withResolvers<void>()
    const writes: ModelChoice[] = []
    let opened = 0
    let cleared = 0
    const selectedModelKey = { providerId: "codex", modelId: "current" }
    const picker = createModelPickerState({
      controller: () => ({ setModel: (_scope, model) => { writes.push(model); return pending.promise }, setThoughtLevel: () => { cleared++ } }),
      scope: () => "session:s1",
      scopeInput: () => ({}),
      selection: () => ({ selectedModelKey, selectedThoughtLevel: "high" }),
      rows: () => ["current", "next", "disconnected"].map((id) => ({ id, name: id, provider: { id: "codex", name: "Codex" }, connected: id !== "disconnected" })),
      picked: () => undefined,
      catalogSelected: () => true,
      catalogVariants: () => [],
      openProviders: () => { opened++ },
      refused: () => { throw new Error("no write was refused") },
    })
    for (const modelId of [undefined, "missing", "current", "disconnected"]) picker().set(modelId ? { providerId: "codex", modelId } : undefined)
    expect(writes).toEqual([])
    expect(opened).toBe(1)
    const next = { providerId: "codex", modelId: "next" }
    picker().set(next)
    picker().set(next)
    expect(writes).toEqual([next])
    expect(cleared).toBe(1)
    pending.resolve()
    await pending.promise
    await Promise.resolve()
    picker().set(next)
    expect(writes).toEqual([next, next])
    dispose()
  })
})

test("a refused model pick reaches the picker's refusal surface", async () => {
  await createRoot(async (dispose) => {
    const refusals: unknown[] = []
    const refusal = new Error("session_config_refused")
    const picker = createModelPickerState({
      controller: () => ({ setModel: async () => { throw refusal }, setThoughtLevel: () => {} }),
      scope: () => "session:s1",
      scopeInput: () => ({}),
      selection: () => ({ selectedModelKey: { providerId: "codex", modelId: "current" }, selectedThoughtLevel: undefined }),
      rows: () => [{ id: "next", name: "next", provider: { id: "codex", name: "Codex" }, connected: true }],
      picked: () => undefined,
      catalogSelected: () => false,
      catalogVariants: () => [],
      openProviders: () => {},
      refused: (error) => { refusals.push(error) },
    })
    picker().set({ providerId: "codex", modelId: "next" })
    await Bun.sleep(0)
    expect(refusals).toEqual([refusal])
    dispose()
  })
})

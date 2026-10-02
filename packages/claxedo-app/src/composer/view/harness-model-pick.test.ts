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

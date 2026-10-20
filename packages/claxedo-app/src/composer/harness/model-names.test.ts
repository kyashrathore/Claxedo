/// <reference types="bun" />
import { expect, test } from "bun:test"
import { createEffect, createRoot } from "solid-js"
import { createModelNames } from "./model-names"

test("two pickers remembering different models each remember once instead of reordering each other forever", () => {
  const runs = createRoot((dispose) => {
    const names = createModelNames()
    const counted = { first: 0, second: 0 }
    createEffect(() => {
      counted.first += 1
      names.remember({ providerId: "openai", modelId: "gpt-4.1" }, "GPT-4.1")
    })
    createEffect(() => {
      counted.second += 1
      names.remember({ providerId: "anthropic", modelId: "claude-haiku-4-5" }, "Claude Haiku 4.5")
    })
    return { counted, names, dispose }
  })
  expect(runs.counted).toEqual({ first: 1, second: 1 })
  expect(runs.names.name({ providerId: "openai", modelId: "gpt-4.1" })).toBe("GPT-4.1")
  expect(runs.names.name({ providerId: "anthropic", modelId: "claude-haiku-4-5" })).toBe("Claude Haiku 4.5")
  runs.dispose()
})

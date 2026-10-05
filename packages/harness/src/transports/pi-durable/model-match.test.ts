import { expect, test } from "bun:test"
import { piLaunchCatalog } from "./launch-catalog"
import { piMatchingModel } from "./model-match"

test("the Pi model matching another harness's model is the same model, else the newest of its family, else the newest Sonnet", () => {
  const match = (hint?: string) => piMatchingModel("anthropic", hint)?.id
  expect(match("claude-opus-4-6")).toBe("anthropic/claude-opus-4-6")
  expect(match("opus")).toBe("anthropic/claude-opus-5-5")
  expect(match("claude-opus-5-5[1m]")).toBe("anthropic/claude-opus-5-5")
  expect(match("haiku")).toBe("anthropic/claude-haiku-4-5")
  expect(match("fable")).toBe("anthropic/claude-fable-5-1")
  expect(match("default")).toBe("anthropic/claude-sonnet-5-5")
  expect(match()).toBe("anthropic/claude-sonnet-5-5")
  expect(piMatchingModel("openai")?.id).toBe("openai/gpt-6.1-sol")
  expect(piMatchingModel("cursor" as never)).toBeUndefined()
})

test("a matched model is one Pi's own launch catalog offers, under the same name", () => {
  for (const provider of ["anthropic", "openai", "openai-codex"] as const) {
    const matched = piMatchingModel(provider)!
    expect(piLaunchCatalog([provider]).find((row) => row.id === matched.id)?.name).toBe(matched.name)
  }
})

import { describe, expect, test } from "bun:test"
import { groupHarnessModels } from "./harness-model-options"
import { nativeHarness } from "@/platform/identity/harness-selection"

describe("groupHarnessModels", () => {
  test("a native SDK harness is one group under its own id", () => {
    const groups = groupHarnessModels(nativeHarness("claude"), [
      { id: "opus", name: "Opus" },
      { id: "sonnet", name: "Sonnet" },
    ])
    expect(groups.map((group) => [group.providerId, group.providerName, group.items.map((item) => item.id)])).toEqual([
      ["claude", "Claude Code", ["opus", "sonnet"]],
    ])
  })

  test("Pi keeps its own id on every row but splits the list by vendor prefix", () => {
    const groups = groupHarnessModels(nativeHarness("pi"), [
      { id: "anthropic/claude-opus", name: "Claude Opus" },
      { id: "openai/gpt", name: "GPT" },
      { id: "anthropic/claude-sonnet", name: "Claude Sonnet" },
    ])
    expect(groups.map((group) => [group.providerId, group.providerName, group.items.map((item) => item.id)])).toEqual([
      ["pi", "Anthropic", ["anthropic/claude-opus", "anthropic/claude-sonnet"]],
      ["pi", "Openai", ["openai/gpt"]],
    ])
    expect(new Set(groups.map((group) => group.key)).size).toBe(2)
  })
})

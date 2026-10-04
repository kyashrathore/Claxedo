/// <reference types="bun" />
import { expect, test } from "bun:test"
import { nativeHarness } from "@/lib/harness-selection"
import { modelLabel, type ModelLabelInput } from "./harness-trigger"

const codex = nativeHarness("codex")
const opencode = nativeHarness("opencode")

test("model label: the placeholders show only when nothing is known", () => {
  const nothing: ModelLabelInput = {
    polling: false,
    harnessLabel: () => "Harness",
    selectedModel: "",
    managedDefault: false,
    modelLoading: false,
    catalogUnread: false,
    hasModelOptions: false,
  }
  expect(modelLabel(nothing), "a new draft with no default").toBe("Select a harness")
  expect(modelLabel({ ...nothing, harness: codex }), "a harness with no model to pick").toBe("Select model")
  expect(modelLabel({ ...nothing, harness: codex, modelLoading: true })).toBe("Loading models")
  expect(modelLabel({ ...nothing, harness: codex, selectedModel: "gpt-5", modelLoading: true }), "a known model while its list loads").toBe("gpt-5")
  expect(modelLabel({ ...nothing, harness: opencode, selectedModel: "claude-sonnet-4-6", catalogUnread: true, rememberedName: "Claude Sonnet 4.6" })).toBe("Claude Sonnet 4.6")
  expect(modelLabel({ ...nothing, harness: codex, selectedModel: "gpt-5", picked: { id: "gpt-5", name: "GPT-5" }, rememberedName: "Old name" })).toBe("GPT-5")
})

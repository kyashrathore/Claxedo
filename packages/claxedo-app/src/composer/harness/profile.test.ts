/// <reference types="bun" />
import { expect, test } from "bun:test"
import { nativeHarness } from "@/lib/harness-selection"
import { harnessModelPickerProvider } from "./profile"

test("Pi's model groups are named as their providers spell themselves", () => {
  const pi = nativeHarness("pi")
  expect(harnessModelPickerProvider(pi, { id: "openai-codex/gpt-5.3-codex" }).name).toBe("OpenAI Codex")
  expect(harnessModelPickerProvider(pi, { id: "xai/grok-4" }).name).toBe("xAI")
  expect(harnessModelPickerProvider(pi, { id: "mistral/large" }).name).toBe("Mistral")
})

import { describe, expect, test } from "bun:test"
import { freeOpenCodeModels } from "./select-model-unpaid"

describe("unpaid OpenCode model filtering", () => {
  test("shows only genuinely free models owned by OpenCode", () => {
    expect(freeOpenCodeModels([
      { id: "free", name: "Free", provider: { id: "opencode", name: "OpenCode" }, cost: { input: 0, output: 0 } },
      { id: "paid", name: "Paid", provider: { id: "opencode", name: "OpenCode" }, cost: { input: 1 } },
      { id: "unknown", name: "Unknown", provider: { id: "opencode", name: "OpenCode" } },
      { id: "gpt-5.5", name: "GPT-5.5", provider: { id: "openai", name: "OpenAI" }, cost: { input: 0, output: 0 } },
      { id: "missing-cost", name: "Unknown", provider: { id: "google", name: "Google" } },
    ])).toEqual([
      { id: "free", name: "Free", provider: { id: "opencode", name: "OpenCode" }, cost: { input: 0, output: 0 } },
    ])
  })
})

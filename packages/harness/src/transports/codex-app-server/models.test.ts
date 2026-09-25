import { expect, test } from "bun:test"
import { codexModelOptions, codexTurnSettings, readCodexModels } from "./models"
import type { CodexRpc } from "./rpc"

test("Codex model pages drive the model, effort, and tier options", async () => {
  const calls: unknown[] = []
  const rpc = { request: async (_method: string, params: unknown) => {
    calls.push(params)
    return calls.length === 1 ? { data: [{ model: "gpt-5.5", displayName: "GPT-5.5", isDefault: true,
      supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }], defaultReasoningEffort: "high",
      serviceTiers: [{ id: "priority", name: "Fast" }] }], nextCursor: "next" } :
      { data: [{ model: "gpt-5.4", displayName: "GPT-5.4", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }] }
  } } as CodexRpc
  const models = await readCodexModels(rpc)
  expect(calls).toEqual([{}, { cursor: "next" }])
  const options = codexModelOptions(models, "default")
  expect(options.map((option) => option.id)).toEqual(["model", "effort", "service_tier"])
  expect(options[0]?.selectOptions?.map((item) => item.id)).toEqual(["gpt-5.5", "gpt-5.4"])
  expect(options[1]?.currentValue).toBe("high")
  expect(options[2]?.selectOptions?.[0]?.id).toBe("priority")
  expect(codexTurnSettings(models, { model: "default", serviceTier: "priority" })).toEqual({
    model: "gpt-5.5", effort: "high", serviceTier: "priority",
  })
  expect(codexTurnSettings(models, { model: "gpt-5.4", serviceTier: "priority" }).serviceTier).toBeNull()
  expect(() => codexTurnSettings(models, { model: "gpt-5.5", effort: "xhigh" })).toThrow("does not run gpt-5.5 at effort xhigh")
})

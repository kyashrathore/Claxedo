import { expect, test } from "bun:test"
import { configOptionsPreview } from "./config-options"

test("a preview names the model its select currently holds, under the label the harness published", () => {
  const options = [{ id: "model", name: "Model", category: "model", type: "select", currentValue: "opus",
    selectOptions: [{ id: "opus", name: "Opus" }, { id: "sonnet", name: "Sonnet" }] }]
  expect(configOptionsPreview(options)).toEqual({ options, resolvedModel: { id: "opus", name: "Opus" } })
  const byId = [{ id: "model", type: "select", currentValue: "sonnet", selectOptions: [{ id: "sonnet", name: "Sonnet" }] }]
  expect(configOptionsPreview(byId)).toEqual({ options: byId, resolvedModel: { id: "sonnet", name: "Sonnet" } })
})

test("a preview carries no resolved model when the select holds none, names an unlabelled id, or is absent", () => {
  const unselected = [{ id: "model", type: "select", selectOptions: [{ id: "opus", name: "Opus" }] }]
  expect(configOptionsPreview(unselected)).toEqual({ options: unselected })
  const unlabelled = [{ id: "model", type: "select", currentValue: "haiku", selectOptions: [{ id: "opus", name: "Opus" }] }]
  expect(configOptionsPreview(unlabelled)).toEqual({ options: unlabelled })
  const effortOnly = [{ id: "effort", type: "select", currentValue: "high", selectOptions: [{ id: "high", name: "High" }] }]
  expect(configOptionsPreview(effortOnly)).toEqual({ options: effortOnly })
  expect(configOptionsPreview([])).toEqual({ options: [] })
})

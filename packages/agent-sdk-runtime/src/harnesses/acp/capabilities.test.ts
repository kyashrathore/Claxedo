import { expect, test } from "bun:test"
import type { AcpConfigOptions } from "./session"
import { acpHarnessCapabilities } from "./capabilities"

const base = { harness: "agent", fork: false, goals: false }
test("ACP effort remains unknown until authoritative session options arrive", () => {
  expect(acpHarnessCapabilities(base).effortLevels).toEqual({ status: "unresolved", models: [] })
  expect(acpHarnessCapabilities({ ...base, config: { options: [] } }).effortLevels).toEqual({ status: "unsupported", models: [] })
})

test("ACP effort reports only the selected model without inventing defaults or other model support", () => {
  const config: AcpConfigOptions = { options: [
    { id: "model", name: "Model", type: "select", category: "model", currentValue: "sonnet", options: [{ value: "sonnet", name: "Sonnet" }, { value: "opus", name: "Opus" }] },
    { id: "effort", name: "Effort", type: "select", category: "thought_level", currentValue: "high", options: [{ group: "levels", name: "Levels", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] }] },
  ] }
  const result = acpHarnessCapabilities({ ...base, config }).effortLevels
  expect(result).toEqual({ status: "unresolved", models: [{ modelID: "sonnet", levels: ["low", "high"] }] })
  expect(acpHarnessCapabilities({ ...base, child: true, config }).effortLevels).toEqual({ status: "unsupported", models: [] })
  expect(acpHarnessCapabilities({ ...base, config: { options: [config.options[1]!] } }).effortLevels).toEqual({ status: "unresolved", models: [] })
})

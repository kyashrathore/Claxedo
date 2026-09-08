import { expect, test } from "bun:test"
import { defaultSessionModel, resolveSessionModel } from "./session-model"

test.each(["claude", "codex", "cursor", "pi"] as const)("an unselected native %s model stays with that harness", (id) => {
  expect(defaultSessionModel({ id, access: "native" })).toEqual({ providerID: id, modelID: "default" })
})

test("an explicitly selected model stays authoritative", () => {
  const model = { providerID: "codex", modelID: "selected-model" }
  expect(resolveSessionModel({ harness: { id: "codex", access: "native" }, model, agent: null, variant: null })).toBe(model)
})

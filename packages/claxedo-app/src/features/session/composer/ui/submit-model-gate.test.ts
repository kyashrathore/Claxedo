import { describe, expect, test } from "bun:test"
import { cloudSubmitMissingModel } from "./submit-model-gate"

describe("submit model gate", () => {
  const base = { isNewSession: true, workspaceKind: "cloud", selection: undefined, modelKey: undefined }
  test("requires a selected harness and its authoritative model key before provisioning", () => {
    const selection = { kind: "native", harnessId: "pi" } as const
    const modelKey = { providerID: "anthropic", modelID: "sonnet" }
    expect(cloudSubmitMissingModel(base)).toBe(true)
    expect(cloudSubmitMissingModel({ ...base, modelKey })).toBe(true)
    expect(cloudSubmitMissingModel({ ...base, selection })).toBe(true)
    expect(cloudSubmitMissingModel({ ...base, selection, modelKey })).toBe(false)
  })
  test("accepts a connection's authoritative managed-default model", () => {
    expect(cloudSubmitMissingModel({ ...base, selection: { kind: "connection", connectionId: "remote" }, modelKey: { providerID: "remote", modelID: "default" } })).toBe(false)
  })
  test("leaves existing and local sessions to their post-resolution gate", () => {
    expect(cloudSubmitMissingModel({ ...base, isNewSession: false })).toBe(false)
    expect(cloudSubmitMissingModel({ ...base, workspaceKind: "local" })).toBe(false)
  })
})

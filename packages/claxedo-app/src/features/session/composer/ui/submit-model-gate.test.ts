import { describe, expect, test } from "bun:test"
import { cloudSubmitMissingModel, resolvePromptSubmitConfig } from "./submit-model-gate"

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

  test("resumed sessions keep their model and agent while accepting provider effort changes", () => {
    const unexpectedDraftRead = () => { throw new Error("A resumed session must not consult draft defaults") }
    expect(resolvePromptSubmitConfig({
      existing: {
        harnessType: { kind: "native", harnessId: "pi" },
        model: { providerID: "saved-provider", modelID: "saved-model" },
        agent: "saved-agent",
        variant: "low",
      },
      harnessMode: true,
      selection: { kind: "native", harnessId: "pi" },
      variant: () => "high",
      modelKey: unexpectedDraftRead,
      currentAgent: unexpectedDraftRead,
      defaultAgent: unexpectedDraftRead,
      agent: () => undefined,
    })).toEqual({
      model: { providerID: "saved-provider", modelID: "saved-model" },
      agent: "saved-agent",
      variant: "high",
    })
  })

  test("connection drafts use the harness model's effort without reading the provider picker", () => {
    const input = {
      harnessMode: true,
      selection: { kind: "connection", connectionId: "remote" } as const,
      variant: () => { throw new Error("Provider effort must not leak into a connection") },
      modelKey: () => ({ providerID: "remote", modelID: "default", variant: "medium" }),
      currentAgent: () => undefined,
      defaultAgent: () => ({ name: "build" }),
      agent: () => undefined,
    }
    expect(resolvePromptSubmitConfig(input)).toEqual({
      model: { providerID: "remote", modelID: "default" }, agent: "build", variant: "medium",
    })
    expect(resolvePromptSubmitConfig({ ...input, modelKey: () => undefined })).toBeUndefined()
  })
})

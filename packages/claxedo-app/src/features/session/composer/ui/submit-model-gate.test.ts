import { describe, expect, test } from "bun:test"
import { cloudSubmitMissingModel, resolvePromptSubmitConfig } from "./submit-model-gate"

describe("submit model gate", () => {
  const base = { isNewSession: true, hostKind: "provisioner", selection: undefined, modelKey: undefined }
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
    expect(cloudSubmitMissingModel({ ...base, hostKind: "self" })).toBe(false)
  })

  test("resumed sessions keep their model and agent while accepting provider effort changes", () => {
    const unexpectedDraftRead = () => { throw new Error("A resumed session must not consult draft defaults") }
    expect(resolvePromptSubmitConfig({
      existing: {
        harnessType: { kind: "native", harnessId: "opencode" },
        model: { providerID: "saved-provider", modelID: "saved-model" },
        agent: "saved-agent",
        variant: "low",
      },
      harnessMode: true,
      selection: { kind: "native", harnessId: "opencode" },
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
    expect(resolvePromptSubmitConfig({ ...input, selection: { kind: "native", harnessId: "pi" } })).toEqual({
      model: { providerID: "remote", modelID: "default" }, agent: "build", variant: "medium",
    })
    expect(resolvePromptSubmitConfig({ ...input, modelKey: () => undefined })).toBeUndefined()
  })
})

test("declared ACP omission stays absent while native prompts still require a model", () => {
 const input = { harnessMode: true, modelOptional: true, selection: { kind: "connection" as const, connectionId: "remote" }, variant: () => undefined, modelKey: () => undefined, currentAgent: () => undefined, defaultAgent: () => ({ name: "build" }), agent: () => undefined }
 expect(resolvePromptSubmitConfig(input)).toEqual({ agent: "build" })
 expect(resolvePromptSubmitConfig({ ...input, selection: { kind: "native", harnessId: "codex" } })).toBeUndefined()
 expect(cloudSubmitMissingModel({ isNewSession: true, hostKind: "provisioner", selection: input.selection, modelKey: undefined, modelOptional: true })).toBe(false)
 expect(cloudSubmitMissingModel({ isNewSession: true, hostKind: "provisioner", selection: { kind: "native", harnessId: "codex" }, modelKey: undefined, modelOptional: true })).toBe(true)
})

test("existing connection omission comes from canonical config before picker hydration", () => {
  const result = resolvePromptSubmitConfig({
    existing: { harnessType: { kind: "connection", connectionId: "agent" }, agent: "build" },
    modelOptional: false, harnessMode: true, selection: undefined,
    modelKey: () => ({ providerID: "stale", modelID: "stale" }),
    variant: () => undefined, currentAgent: () => undefined, defaultAgent: () => undefined, agent: () => undefined,
  })
  expect(result).toEqual({ agent: "build" })
})

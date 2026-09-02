import { describe, expect, test } from "bun:test"
import { SIGNED_WORKSPACE_DEFAULT_MODEL } from "@/features/session/composer/signed-workspace-model"
import { cloudSubmitMissingModel, explicitSelectedModel } from "./submit-model-gate"

describe("submit model gate", () => {
  test("drops the signed-workspace default sentinel but keeps explicit selections", () => {
    expect(explicitSelectedModel(undefined)).toBeUndefined()
    expect(explicitSelectedModel(SIGNED_WORKSPACE_DEFAULT_MODEL)).toBeUndefined()
    const model = { id: "gpt-5.5", provider: { id: "openai" } }
    expect(explicitSelectedModel(model)).toBe(model)
  })

  test("rejects only a new cloud submit that carries no model intent", () => {
    const base = { isNewSession: true, workspaceKind: "cloud", harnessMode: false, hasHarnessModelKey: false, hasSelectedModel: false }
    expect(cloudSubmitMissingModel(base)).toBe(true)
    expect(cloudSubmitMissingModel({ ...base, harnessMode: true })).toBe(true)
    expect(cloudSubmitMissingModel({ ...base, hasSelectedModel: true })).toBe(false)
    expect(cloudSubmitMissingModel({ ...base, harnessMode: true, hasHarnessModelKey: true })).toBe(false)
    // A harness submit is judged by its harness model key, not the picker model.
    expect(cloudSubmitMissingModel({ ...base, harnessMode: true, hasSelectedModel: true })).toBe(true)
    // Existing sessions and non-cloud submits never hit this gate — the full
    // post-resolution gate still applies to them.
    expect(cloudSubmitMissingModel({ ...base, isNewSession: false })).toBe(false)
    expect(cloudSubmitMissingModel({ ...base, workspaceKind: "local" })).toBe(false)
  })
})

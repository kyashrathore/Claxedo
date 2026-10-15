/// <reference types="bun" />
import { expect, test } from "bun:test"
import { cloudConfiguration, cloudPresetModel } from "./cloud-model"
import { cloudHarnessProblem, emptyPresetEditorDraft, parsePresetEditorDraft, type ConfigurationDraft } from "./draft"

function cloudDraft(primary: ConfigurationDraft) {
  const empty = emptyPresetEditorDraft()
  return { ...empty, name: "Cloud review", placement: "cloud" as const, configurations: { ...empty.configurations, primary } }
}

test("a cloud preset runs a harness whose models only a running workspace lists on the harness's own default", () => {
  expect(cloudPresetModel({ id: "claude", access: "native" })).toEqual({ providerID: "claude", modelID: "default" })
  expect(cloudPresetModel({ id: "codex", access: "native" })).toEqual({ providerID: "codex", modelID: "default" })
  expect(cloudPresetModel({ id: "cursor", access: "native" })).toEqual({ providerID: "cursor", modelID: "auto" })
  expect(cloudPresetModel({ id: "opencode", access: "native" })).toBeUndefined()
})

test("choosing Claude Code or Codex for a cloud preset saves it on that default, with no workspace asked", () => {
  for (const id of ["claude", "codex"]) {
    const parsed = parsePresetEditorDraft(cloudDraft(cloudConfiguration({ id, access: "native" })))
    expect(parsed).toMatchObject({
      ok: true,
      draft: {
        execution: { placement: "cloud" },
        configurations: { primary: { harness: { id }, model: { providerID: id, modelID: "default" }, effort: null } },
      },
    })
  }
})

test("a cloud OpenCode configuration has no default to save, and says why instead of asking for a model", () => {
  const draft = cloudDraft(cloudConfiguration({ id: "opencode", access: "native" }))
  const unlisted = { key: "tasks.preset.cloudModelUnlisted", params: { harness: "OpenCode" } } as const
  expect(cloudHarnessProblem(draft, "primary")).toEqual(unlisted)
  const parsed = parsePresetEditorDraft(draft)
  expect(parsed).toMatchObject({ ok: false, fields: { "configurations.primary.cloud": unlisted } })
  expect(parsed.ok ? undefined : parsed.fields["configurations.primary.model"]).toBeUndefined()
})

test("a cloud configuration keeps a model it was saved with", () => {
  const saved: ConfigurationDraft = {
    harness: { id: "claude", access: "native" },
    model: { providerID: "claude", modelID: "claude-haiku-4-5-20251001" },
    effort: null,
  }
  expect(cloudHarnessProblem(cloudDraft(saved), "primary")).toBeUndefined()
  expect(parsePresetEditorDraft(cloudDraft(saved))).toMatchObject({ ok: true, draft: { configurations: { primary: saved } } })
})

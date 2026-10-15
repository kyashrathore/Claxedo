/// <reference types="bun" />
import { expect, test } from "bun:test"
import { cloudHarnessProblem, emptyPresetEditorDraft, parsePresetEditorDraft, type PresetEditorDraft } from "./draft"

function draftWith(harnessId: string, placement: PresetEditorDraft["placement"]): PresetEditorDraft {
  const empty = emptyPresetEditorDraft()
  return {
    ...empty,
    name: "Review",
    placement,
    configurations: {
      ...empty.configurations,
      primary: { harness: { id: harnessId, access: "native" }, model: { providerID: "openai", modelID: "gpt-5" }, effort: null },
    },
  }
}

test("a cloud preset cannot save a harness that runs in its own session host, and says why", () => {
  const pi = draftWith("pi", "cloud")
  expect(cloudHarnessProblem(pi, "primary")).toEqual({ key: "tasks.preset.cloudHarnessElsewhere", params: { harness: "Pi" } })
  expect(parsePresetEditorDraft(pi)).toMatchObject({ ok: false, fields: { "configurations.primary.cloud": { key: "tasks.preset.cloudHarnessElsewhere" } } })
})

test("the same harness saves for a local preset, and a cloud preset saves a harness its workspace runtime runs", () => {
  expect(cloudHarnessProblem(draftWith("pi", "local"), "primary")).toBeUndefined()
  expect(parsePresetEditorDraft(draftWith("pi", "local"))).toMatchObject({ ok: true })
  expect(cloudHarnessProblem(draftWith("codex", "cloud"), "primary")).toBeUndefined()
  expect(parsePresetEditorDraft(draftWith("codex", "cloud"))).toMatchObject({ ok: true })
})

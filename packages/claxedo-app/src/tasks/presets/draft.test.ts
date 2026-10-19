/// <reference types="bun" />
import { expect, test } from "bun:test"
import type { AgentConfiguration } from "@/composer"
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

function cloudDraft(primary: AgentConfiguration) {
  const empty = emptyPresetEditorDraft()
  return { ...empty, name: "Cloud review", placement: "cloud" as const, configurations: { ...empty.configurations, primary } }
}

test("choosing Claude Code or Codex for a cloud preset saves it on that harness's default, with no workspace asked", () => {
  for (const id of ["claude", "codex"]) {
    const onDefault: AgentConfiguration = { harness: { id, access: "native" }, model: { providerID: id, modelID: "default" }, effort: null }
    expect(parsePresetEditorDraft(cloudDraft(onDefault))).toMatchObject({
      ok: true,
      draft: { execution: { placement: "cloud" }, configurations: { primary: { harness: { id }, model: { providerID: id, modelID: "default" }, effort: null } } },
    })
  }
})

test("a cloud OpenCode preset asks for a model and saves the one chosen", () => {
  const opencode = { id: "opencode", access: "native" } as const
  const unchosen = cloudDraft({ harness: opencode, model: null, effort: null })
  expect(cloudHarnessProblem(unchosen, "primary")).toBeUndefined()
  expect(parsePresetEditorDraft(unchosen)).toMatchObject({ ok: false, fields: { "configurations.primary.model": { key: "tasks.preset.chooseModel" } } })
  const chosen: AgentConfiguration = { harness: opencode, model: { providerID: "anthropic", modelID: "claude-opus-4-8" }, effort: null }
  expect(parsePresetEditorDraft(cloudDraft(chosen))).toMatchObject({ ok: true, draft: { configurations: { primary: chosen } } })
})

test("a cloud preset keeps a model it was saved with", () => {
  const saved: AgentConfiguration = { harness: { id: "claude", access: "native" }, model: { providerID: "claude", modelID: "claude-haiku-4-5-20251001" }, effort: null }
  expect(cloudHarnessProblem(cloudDraft(saved), "primary")).toBeUndefined()
  expect(parsePresetEditorDraft(cloudDraft(saved))).toMatchObject({ ok: true, draft: { configurations: { primary: saved } } })
})
